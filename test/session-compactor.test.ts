import { expect, test } from "bun:test"

import { projectAgentContext } from "@/agent/context-projector"
import type {
  IAgentModel,
  IAgentModelRequest,
} from "@/agent/agent-types"
import type {
  ICompactionCheckpoint,
  TAgentMessage,
} from "@/domain"
import {
  compactSessionMessages,
  findCompactionCutoff,
} from "@/session/session-compactor"

test("findCompactionCutoff never separates a tool call from its result", () => {
  const messages: readonly TAgentMessage[] = [
    user("user-1", "Inspect the file"),
    assistant("assistant-tools", [{
      type: "toolCall",
      toolCallId: "call-1",
      toolName: "read_file",
      input: { path: "README.md" },
    }]),
    {
      id: "result-1",
      sessionId: "session-1",
      runId: "run-1",
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read_file",
      content: "Contents",
      isError: false,
      createdAt: 3,
    },
    user("user-2", "Continue", 4),
    assistant("assistant-2", [{ type: "text", text: "Done" }], 5),
  ]

  // Przy maksymalnym cutoff=2 jedyną bezpieczną granicą jest po pierwszym userze.
  expect(findCompactionCutoff(messages, 3)).toBe(1)
  expect(findCompactionCutoff(messages, 1)).toBe(4)
  expect(() => findCompactionCutoff(messages.slice(0, 2), 1)).toThrow(
    "Incomplete tool sequence in compaction history",
  )
})

test("compactSessionMessages updates a previous summary using only the new prefix", async () => {
  const messages = conversation(8)
  const original = structuredClone(messages)
  const previous: ICompactionCheckpoint = {
    id: "checkpoint-old",
    sessionId: "session-1",
    createdAt: 9,
    reason: "manual",
    compactedMessageCount: 2,
    throughMessageId: messages[1]!.id,
    summary: "Earlier summary",
  }
  const requests: IAgentModelRequest[] = []
  const model: IAgentModel = {
    async *stream(request) {
      requests.push(request)
      yield { type: "text-start", id: "summary" }
      yield { type: "text-delta", id: "summary", delta: " Updated summary. " }
      yield { type: "text-end", id: "summary" }
      yield {
        type: "finish",
        reason: "stop",
        usage: { inputTokens: 20, outputTokens: 3, totalTokens: 23 },
      }
    },
  }

  const checkpoint = await compactSessionMessages({
    sessionId: "session-1",
    messages,
    previousCheckpoint: previous,
    runConfiguration: {
      model,
      modelProfile: {
        providerId: "test",
        modelId: "model-1",
        contextWindowTokens: 1_000,
      },
      reasoningEffort: "low",
    },
    reason: "automatic",
    signal: new AbortController().signal,
    now: () => 100,
    generateId: () => "checkpoint-new",
  })

  expect(requests).toHaveLength(1)
  expect(requests[0]).toMatchObject({
    contextSummary: "Earlier summary",
    tools: [],
    maxOutputTokens: 2048,
  })
  expect(requests[0]!.messages.slice(0, -1).map((message) => message.id)).toEqual([
    messages[2]!.id,
    messages[3]!.id,
  ])
  expect(checkpoint).toEqual({
    id: "checkpoint-new",
    sessionId: "session-1",
    createdAt: 100,
    reason: "automatic",
    compactedMessageCount: 4,
    throughMessageId: messages[3]!.id,
    summary: "Updated summary.",
    model: {
      providerId: "test",
      modelId: "model-1",
      contextWindowTokens: 1_000,
    },
    usage: { inputTokens: 20, outputTokens: 3, totalTokens: 23 },
  })
  expect(messages).toEqual(original)
})

test("projectAgentContext returns summary plus tail and rejects a stale anchor", () => {
  const messages = conversation(6)
  const checkpoint: ICompactionCheckpoint = {
    id: "checkpoint-1",
    sessionId: "session-1",
    createdAt: 10,
    reason: "manual",
    compactedMessageCount: 2,
    throughMessageId: messages[1]!.id,
    summary: "Summary",
  }

  const projection = projectAgentContext(messages, checkpoint)
  expect(projection.contextSummary).toBe("Summary")
  expect(projection.messages).toEqual(messages.slice(2))
  expect(projection.messages).not.toBe(messages)
  expect(() => projectAgentContext(messages, {
    ...checkpoint,
    throughMessageId: "missing",
  })).toThrow("Compaction checkpoint does not match session session-1")

  const toolMessages: readonly TAgentMessage[] = [
    user("tool-user", "Read"),
    assistant("tool-assistant", [{
      type: "toolCall",
      toolCallId: "call-1",
      toolName: "read_file",
      input: { path: "README.md" },
    }]),
    {
      id: "tool-result",
      sessionId: "session-1",
      runId: "run-tool",
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read_file",
      content: "Contents",
      isError: false,
      createdAt: 3,
    },
  ]
  expect(() => projectAgentContext(toolMessages, {
    ...checkpoint,
    compactedMessageCount: 2,
    throughMessageId: "tool-assistant",
  })).toThrow("Compaction checkpoint does not match session session-1")
})

function conversation(count: number): TAgentMessage[] {
  return Array.from({ length: count }, (_, index) => (
    index % 2 === 0
      ? user(`user-${index}`, `Question ${index}`, index + 1)
      : assistant(
        `assistant-${index}`,
        [{ type: "text", text: `Answer ${index}` }],
        index + 1,
      )
  ))
}

function user(id: string, content: string, createdAt = 1): TAgentMessage {
  return {
    id,
    sessionId: "session-1",
    runId: `run-${id}`,
    role: "user",
    source: "prompt",
    content,
    createdAt,
  }
}

function assistant(
  id: string,
  content: Extract<TAgentMessage, { role: "assistant" }>["content"],
  createdAt = 2,
): TAgentMessage {
  return {
    id,
    sessionId: "session-1",
    runId: `run-${id}`,
    role: "assistant",
    content,
    stopReason: "stop",
    createdAt,
  }
}
