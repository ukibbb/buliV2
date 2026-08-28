import { expect, test } from "bun:test"

import type {
  TAgentMessage,
  IAgentModel,
  IAgentModelRequest,
} from "@/agent"
import {
  compactSessionMessages,
  type ICompactionCheckpoint,
  projectAgentContext,
} from "@/sessions"

test("compactSessionMessages replaces completed history and retains an unprocessed user", async () => {
  const messages: readonly TAgentMessage[] = [
    user("user-1", "Inspect the file"),
    assistant("assistant-tools", [{
      type: "toolCall",
      toolCallId: "call-1",
      toolName: "read_file",
      input: { path: "README.md" },
    }]),
    toolResult("result-1", "call-1", "Contents", "run-assistant-tools"),
    user("user-2", "Continue", 4),
  ]
  const requests: IAgentModelRequest[] = []

  const checkpoint = await compactSessionMessages({
    sessionId: "session-1",
    messages,
    runConfiguration: configuration(requests, "Completed tool inspection"),
    reason: "automatic",
    signal: new AbortController().signal,
    now: () => 100,
    generateId: () => "checkpoint-1",
  })

  expect(checkpoint).toMatchObject({
    compactedMessageCount: 3,
    throughMessageId: "result-1",
    summary: structuredSummary("Completed tool inspection"),
  })
  expect(requests).toHaveLength(1)
  expect(requests[0]?.systemPrompt).toContain("## Files Read and Why")
  expect(requests[0]?.systemPrompt).toContain("prefer completeness")
  expect(requests[0]?.systemPrompt).not.toContain("below 2048")
  expect(requests[0]?.systemPrompt).not.toContain("below 2,048")
  expect(requests[0]?.messages[0]).toMatchObject({ role: "user" })
  const prompt = requestPrompt(requests[0]!)
  expect(prompt).toContain("[Assistant tool call: read_file]")
  expect(prompt).toContain("[Tool result: read_file]")
  expect(prompt).toContain("Contents")

  const projection = projectAgentContext(messages, checkpoint)
  expect(projection.contextSummary).toBe(structuredSummary("Completed tool inspection"))
  expect(projection.messages).toEqual(messages.slice(3))
})

test("compactSessionMessages updates a previous checkpoint through all completed history", async () => {
  const messages = conversation(8)
  const original = structuredClone(messages)
  const previous: ICompactionCheckpoint = {
    id: "checkpoint-old",
    sessionId: "session-1",
    createdAt: 9,
    reason: "manual",
    compactedMessageCount: 2,
    throughMessageId: messages[1]!.id,
    summary: structuredSummary("Earlier checkpoint"),
  }
  const requests: IAgentModelRequest[] = []

  const checkpoint = await compactSessionMessages({
    sessionId: "session-1",
    messages,
    previousCheckpoint: previous,
    runConfiguration: configuration(requests, "Updated checkpoint"),
    reason: "automatic",
    signal: new AbortController().signal,
    now: () => 100,
    generateId: () => "checkpoint-new",
  })

  expect(requests).toHaveLength(1)
  expect(requests[0]).toMatchObject({
    contextSummary: previous.summary,
    tools: [],
  })
  expect(requestPrompt(requests[0]!)).not.toContain("Question 0")
  expect(requestPrompt(requests[0]!)).toContain("Question 2")
  expect(requestPrompt(requests[0]!)).toContain("Answer 7")
  expect(checkpoint).toEqual({
    id: "checkpoint-new",
    sessionId: "session-1",
    createdAt: 100,
    reason: "automatic",
    compactedMessageCount: 8,
    throughMessageId: messages[7]!.id,
    summary: structuredSummary("Updated checkpoint"),
    model: {
      providerId: "test",
      modelId: "model-1",
      contextWindowTokens: 100_000,
    },
  })
  expect(messages).toEqual(original)
  expect(projectAgentContext(messages, checkpoint).messages).toEqual([])
})

test("compactSessionMessages retains every trailing user not yet processed by a model", async () => {
  const messages: readonly TAgentMessage[] = [
    user("old-user", "Old question"),
    assistant("old-assistant", [{ type: "text", text: "Old answer" }]),
    user("steer", "Adjust this", 3),
    user("follow-up", "Then continue", 4),
  ]

  const checkpoint = await compactSessionMessages({
    sessionId: "session-1",
    messages,
    runConfiguration: configuration([], "Old completed turn"),
    reason: "automatic",
    signal: new AbortController().signal,
    now: () => 100,
    generateId: () => "checkpoint-pending-users",
  })

  expect(checkpoint?.compactedMessageCount).toBe(2)
  expect(projectAgentContext(messages, checkpoint).messages).toEqual(
    messages.slice(2),
  )
})

test("compactSessionMessages rejects incomplete tool history before invoking the model", async () => {
  const messages: readonly TAgentMessage[] = [
    user("user-1", "Inspect"),
    assistant("assistant-tools", [{
      type: "toolCall",
      toolCallId: "call-1",
      toolName: "read_file",
      input: { path: "README.md" },
    }]),
  ]
  let modelCalled = false

  await expect(compactSessionMessages({
    sessionId: "session-1",
    messages,
    runConfiguration: {
      model: {
        async *stream() {
          modelCalled = true
        },
      },
      reasoningEffort: "low",
    },
    reason: "automatic",
    signal: new AbortController().signal,
    now: () => 100,
    generateId: () => "checkpoint-incomplete-tools",
  })).rejects.toThrow("Incomplete tool sequence in compaction history")
  expect(modelCalled).toBe(false)
})

test("compactSessionMessages rejects tool results from a different run or tool", async () => {
  const toolAssistant = assistant("assistant-tools", [{
    type: "toolCall",
    toolCallId: "call-1",
    toolName: "read_file",
    input: { path: "README.md" },
  }])
  const invalidResults = [
    toolResult("wrong-run", "call-1", "Contents", "other-run"),
    {
      ...toolResult(
        "wrong-tool",
        "call-1",
        "Contents",
        toolAssistant.runId,
      ),
      toolName: "grep",
    },
  ]

  for (const result of invalidResults) {
    let modelCalled = false
    await expect(compactSessionMessages({
      sessionId: "session-1",
      messages: [user("user-1", "Inspect"), toolAssistant, result],
      runConfiguration: {
        model: {
          async *stream() {
            modelCalled = true
          },
        },
        reasoningEffort: "low",
      },
      reason: "automatic",
      signal: new AbortController().signal,
      now: () => 100,
      generateId: () => "checkpoint-invalid-tool-result",
    })).rejects.toThrow("Invalid tool sequence in compaction history")
    expect(modelCalled).toBe(false)
  }
})

test("compactSessionMessages replaces a legacy checkpoint beyond the safe cutoff", async () => {
  const messages: readonly TAgentMessage[] = [
    user("old-user", "Old question"),
    assistant("old-assistant", [{ type: "text", text: "Old answer" }]),
    user("legacy-compacted-user", "Retry this", 3),
    {
      ...assistant("failed-assistant", [{ type: "text", text: "Failure" }], 4),
      stopReason: "error",
    },
  ]
  const previous: ICompactionCheckpoint = {
    id: "legacy-checkpoint",
    sessionId: "session-1",
    createdAt: 5,
    reason: "automatic",
    compactedMessageCount: 3,
    throughMessageId: "legacy-compacted-user",
    summary: structuredSummary("Legacy checkpoint ".repeat(100)),
  }

  expect(projectAgentContext(messages, previous)).toEqual({ messages })

  const checkpoint = await compactSessionMessages({
    sessionId: "session-1",
    messages,
    previousCheckpoint: previous,
    allowSummaryRecompression: true,
    runConfiguration: configuration([], "Migrated checkpoint"),
    reason: "automatic",
    signal: new AbortController().signal,
    now: () => 100,
    generateId: () => "checkpoint-migrated",
  })

  expect(checkpoint).toMatchObject({
    compactedMessageCount: 2,
    throughMessageId: "old-assistant",
    summary: structuredSummary("Migrated checkpoint"),
  })
  expect(projectAgentContext(messages, checkpoint).messages).toEqual(
    messages.slice(2),
  )
})

test("compactSessionMessages migrates an unstructured stored checkpoint", async () => {
  const messages = conversation(2)
  const previous: ICompactionCheckpoint = {
    id: "legacy-unstructured",
    sessionId: "session-1",
    createdAt: 3,
    reason: "manual",
    compactedMessageCount: 2,
    throughMessageId: messages[1]!.id,
    summary: "Legacy free-form summary",
  }

  expect(projectAgentContext(messages, previous)).toEqual({ messages })

  const checkpoint = await compactSessionMessages({
    sessionId: "session-1",
    messages,
    previousCheckpoint: previous,
    runConfiguration: configuration([], "Structured migration"),
    reason: "manual",
    signal: new AbortController().signal,
    now: () => 100,
    generateId: () => "checkpoint-structured",
  })

  expect(checkpoint).toMatchObject({
    compactedMessageCount: 2,
    throughMessageId: messages[1]!.id,
    summary: structuredSummary("Structured migration"),
  })
})

test("compactSessionMessages sends full durable tool output through bounded chunks", async () => {
  const imageData = "SECRET_IMAGE_DATA".repeat(1_000)
  const toolOutputMiddle = "SECRET_TOOL_OUTPUT_MIDDLE"
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
    toolResult(
      "tool-result",
      "call-1",
      "R".repeat(3_000) + toolOutputMiddle + "R".repeat(3_000) + toolOutputTail,
      "run-tool-assistant",
    ),
    user("pending-user", "Continue", 4),
  ]
  const requests: IAgentModelRequest[] = []

  const checkpoint = await compactSessionMessages({
    sessionId: "session-1",
    messages,
    runConfiguration: configuration(
      requests,
      "Safe cumulative checkpoint",
      6_000,
    ),
    reason: "automatic",
    signal: new AbortController().signal,
    now: () => 100,
    generateId: () => "checkpoint-full-tool-output",
  })

  expect(requests.length).toBeGreaterThan(1)
  expect(requests.every((request) => request.messages.length === 1)).toBe(true)
  const serializedRequests = JSON.stringify(requests)
  expect(serializedRequests).toContain(
    "[Image attachment: screen.png (image/png)]",
  )
  expect(serializedRequests).toContain("[Assistant tool call: read_file]")
  expect(serializedRequests).toContain(toolOutputMiddle)
  expect(serializedRequests).toContain(toolOutputTail)
  expect(serializedRequests).not.toContain("tool output truncated for compaction")
  expect(serializedRequests).not.toContain("SECRET_IMAGE_DATA")
  expect(serializedRequests).not.toContain("SECRET_REASONING")
  expect(checkpoint).toMatchObject({
    compactedMessageCount: 3,
    throughMessageId: "tool-result",
  })
})

test("compactSessionMessages preserves every UTF-8 byte across chunk boundaries", async () => {
  const content = Array.from(
    { length: 2_000 },
    (_, index) => index % 2 === 0 ? `🙂 ${index}  \n\n` : `żółć ${index}\t`,
  ).join("")
  const messages: readonly TAgentMessage[] = [
    user("utf8-user", content),
    assistant("utf8-assistant", [{ type: "text", text: "Done" }]),
  ]
  const requests: IAgentModelRequest[] = []

  await compactSessionMessages({
    sessionId: "session-1",
    messages,
    runConfiguration: configuration(requests, "UTF-8 checkpoint", 6_000),
    reason: "automatic",
    signal: new AbortController().signal,
    now: () => 100,
    generateId: () => "checkpoint-utf8",
  })

  const prefix = "Conversation history chunk to incorporate:\n\n"
  const suffix = "\n\nMerge this chunk into the cumulative operational checkpoint."
  const chunks = requests.map((request) => {
    const prompt = requestPrompt(request)
    expect(prompt.startsWith(prefix)).toBe(true)
    expect(prompt.endsWith(suffix)).toBe(true)
    return prompt.slice(prefix.length, -suffix.length)
  })
  expect(chunks.length).toBeGreaterThan(1)
  expect(chunks.join("")).toBe(`[User]\n${content}\n\n[Assistant]\nDone`)
})

test("compactSessionMessages recompresses an existing checkpoint at the same anchor", async () => {
  const messages = conversation(2)
  const previous: ICompactionCheckpoint = {
    id: "checkpoint-old",
    sessionId: "session-1",
    createdAt: 3,
    reason: "automatic",
    compactedMessageCount: 2,
    throughMessageId: messages[1]!.id,
    summary: structuredSummary("X".repeat(4_000)),
  }
  const requests: IAgentModelRequest[] = []

  const checkpoint = await compactSessionMessages({
    sessionId: "session-1",
    messages,
    previousCheckpoint: previous,
    allowSummaryRecompression: true,
    runConfiguration: configuration(requests, "Shorter checkpoint"),
    reason: "automatic",
    signal: new AbortController().signal,
    now: () => 100,
    generateId: () => "checkpoint-recompressed",
  })

  expect(checkpoint).toMatchObject({
    id: "checkpoint-recompressed",
    compactedMessageCount: 2,
    throughMessageId: messages[1]!.id,
    summary: structuredSummary("Shorter checkpoint"),
  })
  expect(requests[0]?.contextSummary).toBeUndefined()
  expect(requestPrompt(requests[0]!)).toContain("Operational checkpoint chunk")
})

test("compactSessionMessages rejects same-anchor recompression without size progress", async () => {
  const messages = conversation(2)
  const summary = structuredSummary("Stable checkpoint")
  const previous: ICompactionCheckpoint = {
    id: "checkpoint-old",
    sessionId: "session-1",
    createdAt: 3,
    reason: "automatic",
    compactedMessageCount: 2,
    throughMessageId: messages[1]!.id,
    summary,
  }

  const checkpoint = await compactSessionMessages({
    sessionId: "session-1",
    messages,
    previousCheckpoint: previous,
    allowSummaryRecompression: true,
    runConfiguration: configuration([], "Stable checkpoint"),
    reason: "automatic",
    signal: new AbortController().signal,
    now: () => 100,
    generateId: () => "checkpoint-no-progress",
  })

  expect(checkpoint).toBeUndefined()
})

test("compactSessionMessages accepts same-size text with smaller request serialization", async () => {
  const messages = conversation(2)
  const quotedSummary = structuredSummary("\"".repeat(200))
  const plainSummary = structuredSummary("X".repeat(200))
  expect(Buffer.byteLength(plainSummary, "utf8")).toBe(
    Buffer.byteLength(quotedSummary, "utf8"),
  )
  const previous: ICompactionCheckpoint = {
    id: "checkpoint-escaped",
    sessionId: "session-1",
    createdAt: 3,
    reason: "automatic",
    compactedMessageCount: 2,
    throughMessageId: messages[1]!.id,
    summary: quotedSummary,
  }

  const checkpoint = await compactSessionMessages({
    sessionId: "session-1",
    messages,
    previousCheckpoint: previous,
    allowSummaryRecompression: true,
    runConfiguration: configuration([], "X".repeat(200)),
    reason: "automatic",
    signal: new AbortController().signal,
    now: () => 100,
    generateId: () => "checkpoint-less-escaped",
  })

  expect(checkpoint?.summary).toBe(plainSummary)
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

test("compactSessionMessages rejects truncated or malformed summaries", async () => {
  const truncated: IAgentModel = {
    async *stream() {
      yield { type: "text-delta", id: "summary", delta: structuredSummary("Partial") }
      yield { type: "finish", reason: "max_output_tokens" }
    },
  }
  await expect(compactSessionMessages({
    sessionId: "session-1",
    messages: conversation(4),
    runConfiguration: { model: truncated, reasoningEffort: "low" },
    reason: "automatic",
    signal: new AbortController().signal,
    now: () => 100,
    generateId: () => "checkpoint-truncated",
  })).rejects.toThrow(
    "Compaction model returned an incomplete summary (max_output_tokens)",
  )

  const malformed: IAgentModel = {
    async *stream() {
      yield { type: "text-delta", id: "summary", delta: "Unstructured summary" }
      yield { type: "finish", reason: "stop" }
    },
  }
  await expect(compactSessionMessages({
    sessionId: "session-1",
    messages: conversation(4),
    runConfiguration: { model: malformed, reasoningEffort: "low" },
    reason: "automatic",
    signal: new AbortController().signal,
    now: () => 100,
    generateId: () => "checkpoint-malformed",
  })).rejects.toThrow("Compaction model omitted required section ## Goals")

  const ordered = structuredSummary("Strict structure")
  const invalidStructures = [
    ordered
      .replace("## Goals", "## Temporary")
      .replace("## User Constraints", "## Goals")
      .replace("## Temporary", "## User Constraints"),
    `${ordered}\n\n## Goals\n- Duplicate`,
    `${ordered}\n\n## Extra\n- Unexpected`,
    `Prelude\n${ordered}`,
  ]
  for (const [index, invalidStructure] of invalidStructures.entries()) {
    const invalidModel: IAgentModel = {
      async *stream() {
        yield { type: "text-delta", id: "summary", delta: invalidStructure }
        yield { type: "finish", reason: "stop" }
      },
    }
    await expect(compactSessionMessages({
      sessionId: "session-1",
      messages: conversation(4),
      runConfiguration: { model: invalidModel, reasoningEffort: "low" },
      reason: "automatic",
      signal: new AbortController().signal,
      now: () => 100,
      generateId: () => `checkpoint-invalid-structure-${index}`,
    })).rejects.toThrow()
  }
})

test("compactSessionMessages performs a final abort check", async () => {
  const controller = new AbortController()
  const lateAbort = new Error("Late compaction abort")
  const model: IAgentModel = {
    async *stream() {
      yield { type: "text-delta", id: "summary", delta: structuredSummary("Summary") }
      yield { type: "finish", reason: "stop" }
      controller.abort(lateAbort)
    },
  }

  await expect(compactSessionMessages({
    sessionId: "session-1",
    messages: conversation(4),
    runConfiguration: { model, reasoningEffort: "low" },
    reason: "manual",
    signal: controller.signal,
    now: () => 100,
    generateId: () => "checkpoint-abort",
  })).rejects.toBe(lateAbort)
})

test("projectAgentContext returns a checkpoint plus suffix and rejects a stale anchor", () => {
  const messages = conversation(6)
  const checkpoint: ICompactionCheckpoint = {
    id: "checkpoint-1",
    sessionId: "session-1",
    createdAt: 10,
    reason: "manual",
    compactedMessageCount: 6,
    throughMessageId: messages[5]!.id,
    summary: structuredSummary("Summary"),
  }

  const projection = projectAgentContext(messages, checkpoint)
  expect(projection.contextSummary).toBe(structuredSummary("Summary"))
  expect(projection.messages).toEqual([])
  expect(() => projectAgentContext(messages, {
    ...checkpoint,
    throughMessageId: "missing",
  })).toThrow("Compaction checkpoint does not match session session-1")
})

function configuration(
  requests: IAgentModelRequest[],
  label: string,
  contextWindowTokens = 100_000,
) {
  return {
    model: {
      async *stream(request: IAgentModelRequest) {
        requests.push(request)
        yield {
          type: "text-delta" as const,
          id: "summary",
          delta: structuredSummary(label),
        }
        yield { type: "finish" as const, reason: "stop" }
      },
    },
    modelProfile: {
      providerId: "test",
      modelId: "model-1",
      contextWindowTokens,
    },
    reasoningEffort: "low" as const,
  }
}

function structuredSummary(label: string): string {
  return `## Goals
- ${label}

## User Constraints
- (none)

## Active Request
- ${label}

## Files Read and Why
- (none)

## Modifications
- (none)

## Commands and Tests
- (none)

## Decisions
- (none)

## Current State
- ${label}

## Next Steps
1. Continue

## Handoff Guidance
- Reread reproducible data when exact details are needed.`
}

function requestPrompt(request: IAgentModelRequest): string {
  const message = request.messages[0]
  if (message?.role !== "user") throw new Error("Expected summary user prompt")
  return message.content
}

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
): Extract<TAgentMessage, { role: "assistant" }> {
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

function toolResult(
  id: string,
  toolCallId: string,
  content: string,
  runId: string,
): Extract<TAgentMessage, { role: "toolResult" }> {
  return {
    id,
    sessionId: "session-1",
    runId,
    role: "toolResult",
    toolCallId,
    toolName: "read_file",
    content,
    isError: false,
    createdAt: 3,
  }
}
