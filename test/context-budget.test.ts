import { Buffer } from "node:buffer"

import { expect, test } from "bun:test"

import type { AgentMessage } from "@/agent"
import {
  CONTEXT_COMPACTION_THRESHOLD,
  contextCompactionThresholdTokens,
  ESTIMATED_BYTES_PER_TOKEN,
  ESTIMATED_IMAGE_TOKENS,
  estimateContextInputTokens,
  estimateContextUsage,
  estimateMessagesInputTokens,
  shouldCompactContext,
} from "@/sessions"

test("estimates a documented provider-visible serialization at two UTF-8 bytes per token", () => {
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

  expect(ESTIMATED_BYTES_PER_TOKEN).toBe(2)
  expect(estimateContextInputTokens(input)).toBe(
    Math.ceil(Buffer.byteLength(serialized, "utf8") / ESTIMATED_BYTES_PER_TOKEN),
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
  const withReasoning: AgentMessage = {
    ...visible,
    content: [
      ...visible.content,
      { type: "reasoning", text: "R".repeat(10_000) },
    ],
  }
  const failed: AgentMessage = {
    ...assistant("assistant-error", [{
      type: "text",
      text: "E".repeat(10_000),
    }]),
    stopReason: "error",
  }
  const aborted: AgentMessage = {
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
  const withImage: AgentMessage = {
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

test("uses retained provider input usage as a conservative estimate floor", () => {
  const measured: AgentMessage = {
    ...assistant("measured-assistant", [{ type: "text", text: "Short answer" }]),
    usage: { inputTokens: 238_000, outputTokens: 200, totalTokens: 238_200 },
  }

  const usage = estimateContextUsage({
    systemPrompt: "System",
    messages: [user("user-1", "Short question"), measured],
    tools: [],
  }, 272_000)

  expect(usage).toMatchObject({
    compactionThresholdTokens: 217_600,
    shouldCompact: true,
  })
  expect(usage.estimatedInputTokens).toBeGreaterThan(238_000)

  const appendedOutput = estimateContextUsage({
    systemPrompt: "System",
    messages: [user("user-2", "Question"), {
      ...assistant("assistant-2", [{
        type: "text",
        text: "X".repeat(10_000),
      }]),
      usage: { inputTokens: 210_000, outputTokens: 4_000, totalTokens: 214_000 },
    }],
    tools: [],
  }, 272_000)
  expect(appendedOutput.estimatedInputTokens).toBeGreaterThan(217_600)
  expect(appendedOutput.shouldCompact).toBe(true)

  const changedPrefix = estimateContextUsage({
    systemPrompt: "Changed system prompt",
    contextSummary: "S".repeat(2_000),
    messages: [{
      ...assistant("assistant-3", [{ type: "text", text: "Answer" }]),
      usage: { inputTokens: 79_000, outputTokens: 100, totalTokens: 79_100 },
    }],
    tools: [],
  }, 100_000)
  expect(changedPrefix.shouldCompact).toBe(true)
})

test("uses a byte-level safety bound before provider usage is available", () => {
  const usage = estimateContextUsage({
    systemPrompt: "System",
    messages: [user("large-first-user", "X".repeat(220_000))],
    tools: [],
  }, 272_000)

  expect(usage.estimatedInputTokens).toBeLessThan(217_600)
  expect(usage.shouldCompact).toBe(true)
})

test("discards a provider usage anchor after the model changes", () => {
  const usage = estimateContextUsage({
    systemPrompt: "System",
    modelProfile: {
      providerId: "provider",
      modelId: "new-model",
      contextWindowTokens: 1_000,
    },
    messages: [user("old-user", "X".repeat(800)), {
      ...assistant("old-assistant", [{ type: "text", text: "Answer" }]),
      model: {
        providerId: "provider",
        modelId: "old-model",
        contextWindowTokens: 2_000,
      },
      usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
    }],
    tools: [],
  }, 1_000)

  expect(usage.estimatedInputTokens).toBeLessThan(800)
  expect(usage.shouldCompact).toBe(true)
})

function user(
  id: string,
  content: string,
): Extract<AgentMessage, { role: "user" }> {
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
  content: Extract<AgentMessage, { role: "assistant" }>["content"],
): Extract<AgentMessage, { role: "assistant" }> {
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

function toolResult(id: string, content: string): AgentMessage {
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
