import { expect, test } from "bun:test"
import { AssistantMessageBuilder, isImmutableAssistantSnapshot } from "@/agent/engine/assistant-message-builder"
import { streamModelTurn } from "@/agent/engine/model-turn"
import type { TAgentEvent } from "@/agent/events"
import type { TAgentModelEvent } from "@/agent/model"
import type { IModelProfile } from "@/agent/model-values"

function builder(modelProfile?: IModelProfile): AssistantMessageBuilder {
  return new AssistantMessageBuilder({
    sessionId: "session", runId: "run", generateId: () => "assistant", now: () => 42,
    ...(modelProfile === undefined ? {} : { modelProfile }),
  })
}

function expectDeeplyFrozen(value: unknown): void {
  if (value === null || typeof value !== "object") return
  expect(Object.isFrozen(value)).toBe(true)
  for (const child of Object.values(value)) expectDeeplyFrozen(child)
}

test("publishes a new frozen shell and content array even without content changes", () => {
  const message = builder()
  const first = message.snapshot()
  const second = message.snapshot()
  expect(first).toEqual({
    id: "assistant", sessionId: "session", runId: "run", role: "assistant",
    content: [], stopReason: "pending", createdAt: 42,
  })
  expect(second).toEqual(first)
  expect(second).not.toBe(first)
  expect(second.content).not.toBe(first.content)
  expectDeeplyFrozen(first)
  expectDeeplyFrozen(second)
  expect(isImmutableAssistantSnapshot(first)).toBe(true)
  expect(isImmutableAssistantSnapshot(second)).toBe(true)
  expect(isImmutableAssistantSnapshot(structuredClone(first))).toBe(false)
})

test("replaces only changed text or reasoning and shares unchanged frozen fragments", () => {
  const message = builder()
  message.apply({ type: "reasoning-start", id: "reasoning" })
  message.apply({ type: "reasoning-delta", id: "reasoning", delta: "Think" })
  message.apply({ type: "tool-call", toolCallId: "call", toolName: "read", input: { paths: ["a.ts"] } })
  message.apply({ type: "text-start", id: "text" })
  const first = message.snapshot()

  message.apply({ type: "text-delta", id: "text", delta: "Answer" })
  const second = message.snapshot()
  expect(second.content).not.toBe(first.content)
  expect(second.content[0]).toBe(first.content[0])
  expect(second.content[1]).toBe(first.content[1])
  expect(second.content[2]).not.toBe(first.content[2])
  expect(first.content[2]).toEqual({ type: "text", text: "" })
  expect(second.content[2]).toEqual({ type: "text", text: "Answer" })

  message.apply({ type: "reasoning-delta", id: "reasoning", delta: " again" })
  const third = message.snapshot()
  expect(third.content[0]).not.toBe(second.content[0])
  expect(third.content[1]).toBe(second.content[1])
  expect(third.content[2]).toBe(second.content[2])
  expect(first.content[0]).toEqual({ type: "reasoning", text: "Think" })
  expect(third.content[0]).toEqual({ type: "reasoning", text: "Think again" })
  for (const snapshot of [first, second, third]) expectDeeplyFrozen(snapshot)
})

test("detaches and deeply freezes tool inputs at acceptance without freezing provider data", () => {
  const message = builder()
  const input = { edits: [{ path: "a.ts", lines: ["original"] }] }
  message.apply({ type: "tool-call", toolCallId: "call", toolName: "edit", input })
  input.edits[0]!.lines[0] = "changed before publication"
  const first = message.snapshot()
  const call = first.content[0]
  if (call?.type !== "toolCall") throw new Error("Expected tool call")
  expect(call.input).toEqual({ edits: [{ path: "a.ts", lines: ["original"] }] })
  expect(call.input).not.toBe(input)
  expectDeeplyFrozen(first)
  expect(Object.isFrozen(input)).toBe(false)
  expect(Object.isFrozen(input.edits[0]!.lines)).toBe(false)

  input.edits.push({ path: "b.ts", lines: [] })
  const accepted = call.input as typeof input
  expect(() => { accepted.edits[0]!.lines.push("observer mutation") }).toThrow()
  expect(() => { accepted.edits[0]!.path = "observer.ts" }).toThrow()
  message.apply({ type: "text-start", id: "text" })
  message.apply({ type: "text-delta", id: "text", delta: "Done" })
  const second = message.snapshot()
  expect(second.content[0]).toBe(call)
  expect(second.content).toHaveLength(2)
  expect(first.content).toHaveLength(1)
  expect(accepted).toEqual({ edits: [{ path: "a.ts", lines: ["original"] }] })
})

test("captures model metadata once and shares detached frozen model and usage values", () => {
  const profile = { providerId: "provider", modelId: "model", contextWindowTokens: 100_000 }
  const usage = { inputTokens: 10, outputTokens: 20, totalTokens: 30, cacheReadTokens: 5, cacheWriteTokens: 2, reasoningTokens: 3 }
  const message = builder(profile)
  profile.modelId = "external change before publication"
  const first = message.snapshot()
  message.apply({ type: "text-start", id: "text" })
  const partial = message.snapshot()
  message.apply({ type: "finish", reason: "length", usage })
  usage.outputTokens = 999
  const final = message.snapshot()
  const repeated = message.snapshot()
  expect(final.model).toEqual({ providerId: "provider", modelId: "model", contextWindowTokens: 100_000 })
  expect(final.model).not.toBe(profile)
  expect(partial.model).toBe(first.model)
  expect(final.model).toBe(first.model)
  expect(first.usage).toBeUndefined()
  expect(final.usage).toEqual({ inputTokens: 10, outputTokens: 20, totalTokens: 30, cacheReadTokens: 5, cacheWriteTokens: 2, reasoningTokens: 3 })
  expect(final.usage).not.toBe(usage)
  expect(repeated.usage).toBe(final.usage)
  expect(final.content[0]).toBe(partial.content[0])
  expect(final.stopReason).toBe("length")
  expectDeeplyFrozen(final)
  expect(Object.isFrozen(profile)).toBe(false)
  expect(Object.isFrozen(usage)).toBe(false)
})

for (const kind of ["text", "reasoning"] as const) {
  test(`${kind} streams retain start/end boundaries, duplicate suppression and content ordering`, () => {
    const message = builder()
    message.apply({ type: `${kind}-delta`, id: "missing", delta: "ignored" })
    message.apply({ type: `${kind}-start`, id: "part" })
    message.apply({ type: `${kind}-start`, id: "part" })
    message.apply({ type: `${kind}-delta`, id: "part", delta: "First" })
    message.apply({ type: `${kind}-end`, id: "part" })
    const first = message.snapshot()
    message.apply({ type: `${kind}-delta`, id: "part", delta: "ignored after end" })
    message.apply({ type: `${kind}-start`, id: "part" })
    message.apply({ type: `${kind}-delta`, id: "part", delta: "Second" })
    expect(first.content).toEqual([{ type: kind, text: "First" }])
    expect(message.snapshot().content).toEqual([{ type: kind, text: "First" }, { type: kind, text: "Second" }])
    expect(message.snapshot().content[0]).toBe(first.content[0])
  })
}

test("duplicate tool call IDs do not replace the accepted frozen call", () => {
  const message = builder()
  message.apply({ type: "tool-call", toolCallId: "call", toolName: "read", input: { path: "first.ts" } })
  const first = message.snapshot()
  message.apply({ type: "tool-call", toolCallId: "call", toolName: "write", input: { path: "second.ts" } })
  const second = message.snapshot()
  expect(second.content).toEqual(first.content)
  expect(second.content).toHaveLength(1)
  expect(second.content[0]).toBe(first.content[0])
})

for (const [event, stopReason, errorMessage] of [
  [{ type: "finish", reason: "stop" }, "stop", undefined],
  [{ type: "error", error: new Error("Provider failed") }, "error", "Provider failed"],
  [{ type: "error", error: "Failure" }, "error", "Failure"],
  [{ type: "abort" }, "aborted", "Buli interaction was aborted"],
  [{ type: "abort", reason: "Cancelled" }, "aborted", "Cancelled"],
] satisfies [TAgentModelEvent, string, string | undefined][]) {
  test(`retains partial content and ignores further provider events after ${stopReason}: ${errorMessage}`, () => {
    const message = builder()
    message.apply({ type: "text-start", id: "text" })
    message.apply({ type: "text-delta", id: "text", delta: "Partial" })
    const partial = message.snapshot()
    message.apply(event)
    const final = message.snapshot()
    message.apply({ type: "text-delta", id: "text", delta: "ignored" })
    message.apply({ type: "tool-call", toolCallId: "ignored", toolName: "read", input: {} })
    message.finish("another finish")
    expect(message.completed).toBe(true)
    expect(message.snapshot()).toEqual(final)
    expect(final.stopReason).toBe(stopReason)
    expect(final.errorMessage).toBe(errorMessage)
    expect(final.content[0]).toBe(partial.content[0])
    expect(partial.stopReason).toBe("pending")
    expectDeeplyFrozen(final)
  })
}

test("late cancellation overrides completion without changing the earlier final snapshot or usage", () => {
  const message = builder()
  message.finish("stop", undefined, { outputTokens: 10 })
  const final = message.snapshot()
  message.abort("Late cancellation")
  const aborted = message.snapshot()
  expect(final.stopReason).toBe("stop")
  expect(final.errorMessage).toBeUndefined()
  expect(aborted.stopReason).toBe("aborted")
  expect(aborted.errorMessage).toBe("Late cancellation")
  expect(aborted.usage).toBe(final.usage)
  expectDeeplyFrozen(aborted)
})

test("model turns still publish and await every stream update in order", async () => {
  const events: TAgentEvent[] = []
  let updates = 0
  const result = await streamModelTurn({
    sessionId: "session", runId: "run", systemPrompt: "Test", messages: [], tools: [],
    reasoningEffort: "low", signal: new AbortController().signal,
    now: () => 42, generateId: () => "assistant",
    model: { async *stream() {
      yield { type: "text-start", id: "text" }
      for (let index = 0; index < 5; index++) {
        expect(updates).toBe(index + 1)
        yield { type: "text-delta", id: "text", delta: String(index) }
      }
      yield { type: "text-end", id: "text" }
      yield { type: "finish", reason: "stop" }
    } },
    emit: async (event) => {
      await Promise.resolve()
      events.push(event)
      if (event.type === "message_update") updates++
    },
  })
  expect(events.map((event) => event.type)).toEqual([
    "message_start", ...Array(7).fill("message_update"), "message_end",
  ])
  expect(events.filter((event) => event.type === "message_update").map((event) => event.message.content))
    .toEqual(["", "0", "01", "012", "0123", "01234", "01234"].map((text) => [{ type: "text", text }]))
  expect(result.content).toEqual([{ type: "text", text: "01234" }])
  expect(result.stopReason).toBe("stop")
  expect(events.at(-1)).toMatchObject({ message: result })
})
