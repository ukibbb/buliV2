import { expect, test } from "bun:test"

import type { TAgentMessage } from "@/agent"
import {
  CONTEXT_COMPACTION_THRESHOLD,
  contextCompactionThresholdTokens,
  ESTIMATED_CHARS_PER_TOKEN,
  ESTIMATED_IMAGE_TOKENS,
  estimateContextInputTokens,
  estimateContextUsage,
  estimateMessagesInputTokens,
  shouldCompactContext,
} from "@/sessions"

test("estimates a documented provider-visible serialization at four chars per token", () => {
  const input = {
    systemPrompt: "System",
    messages: [user("user-1", "Hello")],
    tools: [],
  }
  const serialized = JSON.stringify({
    systemPrompt: "System",
    messages: [{ role: "user", content: "Hello" }],
    tools: [],
  })

  expect(ESTIMATED_CHARS_PER_TOKEN).toBe(4)
  expect(estimateContextInputTokens(input)).toBe(
    Math.ceil(serialized.length / ESTIMATED_CHARS_PER_TOKEN),
  )
})

test("includes prompts, summaries, messages, tool calls, results, and descriptors", () => {
  const base = estimateContextInputTokens({
    systemPrompt: "",
    messages: [],
    tools: [],
  })
  const complete = estimateContextInputTokens({
    systemPrompt: "S".repeat(80),
    contextSummary: "C".repeat(80),
    messages: [
      user("user-1", "U".repeat(80)),
      assistant("assistant-1", [{
        type: "toolCall",
        toolCallId: "call-1",
        toolName: "read_file",
        input: { path: "P".repeat(80) },
      }]),
      toolResult("result-1", "R".repeat(80)),
    ],
    tools: [{
      name: "read_file",
      description: "D".repeat(80),
      inputSchema: { type: "object", title: "T".repeat(80) },
    }],
  })

  expect(complete).toBeGreaterThan(base + 100)
})

test("does not count reasoning or failed and aborted assistant content", () => {
  const visible = assistant("assistant-visible", [{
    type: "text",
    text: "Visible answer",
  }])
  const withReasoning: TAgentMessage = {
    ...visible,
    content: [
      ...visible.content,
      { type: "reasoning", text: "R".repeat(10_000) },
    ],
  }
  const failed: TAgentMessage = {
    ...assistant("assistant-error", [{
      type: "text",
      text: "E".repeat(10_000),
    }]),
    stopReason: "error",
  }
  const aborted: TAgentMessage = {
    ...assistant("assistant-aborted", [{
      type: "text",
      text: "A".repeat(10_000),
    }]),
    stopReason: "aborted",
  }

  expect(estimateMessagesInputTokens([withReasoning])).toBe(
    estimateMessagesInputTokens([visible]),
  )
  expect(estimateMessagesInputTokens([failed, aborted])).toBe(
    estimateMessagesInputTokens([]),
  )
})

test("adds a conservative token estimate for direct image inputs", () => {
  const plain = user("plain", "Inspect image")
  const withImage: TAgentMessage = {
    ...plain,
    attachments: [{
      type: "image",
      mimeType: "image/png",
      data: "ignored-by-estimator",
      filename: "image.png",
      source: { value: "image", start: 8, end: 13 },
    }],
  }

  expect(estimateMessagesInputTokens([withImage])).toBe(
    estimateMessagesInputTokens([plain]) + ESTIMATED_IMAGE_TOKENS,
  )
})

test("reports the fixed 80 percent threshold and optional context usage", () => {
  expect(CONTEXT_COMPACTION_THRESHOLD).toBe(0.8)
  expect(contextCompactionThresholdTokens(100)).toBe(80)
  expect(contextCompactionThresholdTokens(101)).toBe(81)
  expect(shouldCompactContext(79, 100)).toBe(false)
  expect(shouldCompactContext(80, 100)).toBe(true)
  expect(shouldCompactContext(100)).toBe(false)

  const input = {
    systemPrompt: "System",
    messages: [user("user-1", "Hello")],
    tools: [],
  }
  const estimatedInputTokens = estimateContextInputTokens(input)
  expect(estimateContextUsage(input)).toEqual({
    estimatedInputTokens,
    shouldCompact: false,
  })
  expect(estimateContextUsage(input, estimatedInputTokens)).toEqual({
    estimatedInputTokens,
    contextWindowTokens: estimatedInputTokens,
    compactionThresholdTokens: Math.ceil(estimatedInputTokens * 0.8),
    remainingTokens: 0,
    usageRatio: 1,
    shouldCompact: true,
  })
})

function user(
  id: string,
  content: string,
): Extract<TAgentMessage, { role: "user" }> {
  return {
    id,
    sessionId: "session-1",
    runId: `run-${id}`,
    role: "user",
    source: "prompt",
    content,
    createdAt: 1,
  }
}

function assistant(
  id: string,
  content: Extract<TAgentMessage, { role: "assistant" }>["content"],
): Extract<TAgentMessage, { role: "assistant" }> {
  return {
    id,
    sessionId: "session-1",
    runId: `run-${id}`,
    role: "assistant",
    content,
    stopReason: "stop",
    createdAt: 2,
  }
}

function toolResult(id: string, content: string): TAgentMessage {
  return {
    id,
    sessionId: "session-1",
    runId: `run-${id}`,
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "read_file",
    content,
    isError: false,
    createdAt: 3,
  }
}
