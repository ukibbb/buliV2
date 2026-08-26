import { expect, test } from "bun:test"

import type {
  IAgentModel,
  IAgentModelRequest,
  TAgentMessage,
} from "@/agent"
import {
  compactSessionMessages,
  estimateMessagesInputTokens,
  findCompactionCutoff,
  type ICompactionCheckpoint,
  MAX_RETAINED_CONTEXT_TOKENS,
  projectAgentContext,
  retainedContextTargetTokens,
} from "@/sessions"

test("findCompactionCutoff retains a user-led suffix and complete tool batches", () => {
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

  const latestTurnBudget = estimateMessagesInputTokens(messages.slice(3))
  const cutoff = findCompactionCutoff(messages, latestTurnBudget)
  expect(cutoff).toBe(3)
  expect(messages[cutoff!]?.role).toBe("user")
  expect(messages.slice(0, cutoff).map((message) => message.role)).toEqual([
    "user",
    "assistant",
    "toolResult",
  ])
  expect(() => findCompactionCutoff(messages.slice(0, 2), latestTurnBudget)).toThrow(
    "Incomplete tool sequence in compaction history",
  )
})

test("findCompactionCutoff adapts retained turns to the request budget", () => {
  const messages = conversation(8)
  const threeTurnBudget = estimateMessagesInputTokens(messages.slice(2))

  expect(findCompactionCutoff(messages, threeTurnBudget)).toBe(2)
  expect(messages.slice(2)).toHaveLength(6)

  const oversizedLatestTurn = [
    ...conversation(2),
    user("large-user", "U".repeat(10_000), 3),
    assistant("large-assistant", [{
      type: "text",
      text: "A".repeat(10_000),
    }], 4),
  ]
  expect(findCompactionCutoff(oversizedLatestTurn, 0)).toBe(4)
})

test("findCompactionCutoff caps retained context at 20k tokens", () => {
  const messages: readonly TAgentMessage[] = [
    user("large-user", "U".repeat(80_000)),
    assistant("large-assistant", [{ type: "text", text: "Large answer" }]),
    user("latest-user", "Latest question", 3),
    assistant("latest-assistant", [{ type: "text", text: "Latest answer" }], 4),
  ]

  expect(retainedContextTargetTokens(100_000)).toBe(
    MAX_RETAINED_CONTEXT_TOKENS,
  )
  expect(findCompactionCutoff(messages, 100_000)).toBe(2)
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
    requestBudgetTokens: estimateMessagesInputTokens(messages.slice(4)),
    runConfiguration: {
      model,
      modelProfile: {
        providerId: "test",
        modelId: "model-1",
        contextWindowTokens: 4_096,
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
  expect(requests[0]!.messages).toHaveLength(1)
  expect(requests[0]!.messages[0]).toMatchObject({ role: "user" })
  expect(requests[0]!.messages[0]?.role === "user"
    && requests[0]!.messages[0].content).toContain("[User]\nQuestion 2")
  expect(requests[0]!.messages[0]?.role === "user"
    && requests[0]!.messages[0].content).toContain("[Assistant]\nAnswer 3")
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
      contextWindowTokens: 4_096,
    },
    usage: { inputTokens: 20, outputTokens: 3, totalTokens: 23 },
  })
  expect(messages).toEqual(original)
})

test("compactSessionMessages sanitizes images and bounded tool output", async () => {
  const imageData = "SECRET_IMAGE_DATA".repeat(1_000)
  const toolOutputTail = "SECRET_TOOL_OUTPUT_TAIL"
  const messages: readonly TAgentMessage[] = [
    {
      ...user("image-user", "Inspect the image"),
      attachments: [{
        type: "image",
        mimeType: "image/png",
        data: imageData,
        filename: "screen.png",
        source: { value: "image", start: 8, end: 13 },
      }],
    },
    assistant("tool-assistant", [
      { type: "reasoning", text: "SECRET_REASONING" },
      {
        type: "toolCall",
        toolCallId: "call-1",
        toolName: "read_file",
        input: { path: "README.md" },
      },
    ]),
    {
      id: "tool-result",
      sessionId: "session-1",
      runId: "run-tool",
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read_file",
      content: "R".repeat(5_000) + toolOutputTail,
      isError: false,
      createdAt: 3,
    },
    user("retained-user", "Continue", 4),
  ]
  const requests: IAgentModelRequest[] = []
  const checkpoint = await compactSessionMessages({
    sessionId: "session-1",
    messages,
    requestBudgetTokens: estimateMessagesInputTokens(messages.slice(3)),
    runConfiguration: {
      model: {
        async *stream(request) {
          requests.push(request)
          yield { type: "text-delta", id: "summary", delta: "Safe summary" }
          yield { type: "finish", reason: "stop" }
        },
      },
      modelProfile: {
        providerId: "test",
        modelId: "model-1",
        contextWindowTokens: 4_096,
      },
      reasoningEffort: "low",
    },
    reason: "automatic",
    signal: new AbortController().signal,
    now: () => 100,
    generateId: () => "checkpoint-sanitized",
  })

  expect(requests.length).toBeGreaterThan(1)
  expect(requests.every((request) => request.messages.length === 1)).toBe(true)
  expect(requests[0]?.contextSummary).toBeUndefined()
  expect(requests[1]?.contextSummary).toBe("Safe summary")
  const serializedRequest = JSON.stringify(requests)
  expect(serializedRequest).toContain(
    "[Image attachment: screen.png (image/png)]",
  )
  expect(serializedRequest).toContain("[Assistant tool call: read_file]")
  expect(serializedRequest).toContain("tool output truncated for compaction")
  expect(serializedRequest).toContain(toolOutputTail)
  expect(serializedRequest).not.toContain("SECRET_IMAGE_DATA")
  expect(serializedRequest).not.toContain("SECRET_REASONING")
  expect(checkpoint).toMatchObject({
    compactedMessageCount: 3,
    throughMessageId: "tool-result",
    summary: "Safe summary",
  })
})

test("compactSessionMessages rejects summary input that cannot fit its model", async () => {
  let modelCalled = false
  const model: IAgentModel = {
    async *stream() {
      modelCalled = true
      yield { type: "finish", reason: "stop" }
    },
  }

  await expect(compactSessionMessages({
    sessionId: "session-1",
    messages: conversation(4),
    requestBudgetTokens: 0,
    runConfiguration: {
      model,
      modelProfile: {
        providerId: "test",
        modelId: "small-summarizer",
        contextWindowTokens: 2_050,
      },
      reasoningEffort: "low",
    },
    reason: "manual",
    signal: new AbortController().signal,
    now: () => 100,
    generateId: () => "checkpoint-small",
  })).rejects.toThrow(
    "Compaction summary input does not fit the summarizer model context",
  )
  expect(modelCalled).toBe(false)
})

test("compactSessionMessages rejects a truncated summary", async () => {
  const model: IAgentModel = {
    async *stream() {
      yield { type: "text-delta", id: "summary", delta: "Partial summary" }
      yield { type: "finish", reason: "max_output_tokens" }
    },
  }

  await expect(compactSessionMessages({
    sessionId: "session-1",
    messages: conversation(4),
    requestBudgetTokens: 0,
    runConfiguration: { model, reasoningEffort: "low" },
    reason: "automatic",
    signal: new AbortController().signal,
    now: () => 100,
    generateId: () => "checkpoint-truncated",
  })).rejects.toThrow(
    "Compaction model returned an incomplete summary (max_output_tokens)",
  )
})

test("compactSessionMessages performs a final abort check", async () => {
  const controller = new AbortController()
  const lateAbort = new Error("Late compaction abort")
  const model: IAgentModel = {
    async *stream() {
      yield { type: "text-delta", id: "summary", delta: "Summary" }
      yield { type: "finish", reason: "stop" }
      controller.abort(lateAbort)
    },
  }

  await expect(compactSessionMessages({
    sessionId: "session-1",
    messages: conversation(4),
    requestBudgetTokens: 0,
    runConfiguration: { model, reasoningEffort: "low" },
    reason: "manual",
    signal: controller.signal,
    now: () => 100,
    generateId: () => "checkpoint-abort",
  })).rejects.toBe(lateAbort)
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

function user(
  id: string,
  content: string,
  createdAt = 1,
): Extract<TAgentMessage, { role: "user" }> {
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
