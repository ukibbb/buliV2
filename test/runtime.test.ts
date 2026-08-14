import { expect, test } from "bun:test"
import {
  BuliApplicationRuntime,
  type IBuliPromptInput,
} from "@/application"
import type { IAgentModel, IAgentModelEvent } from "@/agent/agent-types"
import { InMemorySessionManager } from "@/session/session-manager"

const WORKSPACE_ROOT = "/workspace"

const model: IAgentModel = {
  async *stream() {},
}

function runtimeWith(modelOverride: IAgentModel = model): BuliApplicationRuntime {
  return new BuliApplicationRuntime({
    manager: new InMemorySessionManager(),
    models: [{
      id: "test",
      name: "Test",
      model: modelOverride,
      reasoningEfforts: ["medium"],
    }],
    selection: {
      modelId: "test",
      reasoningEffort: "medium",
    },
    workspaceRoot: WORKSPACE_ROOT,
  })
}

function createSession(
  runtime: BuliApplicationRuntime,
  sessionId = "session-1",
) {
  return runtime.createAgentSession({
    sessionId,
    systemPrompt: "System",
    tools: [],
  })
}

test("application runtime submits prompts into its session view", async () => {
  const events: IAgentModelEvent[] = [
    { type: "text-start", id: "answer" },
    { type: "text-delta", id: "answer", delta: "Hello from Buli" },
    { type: "text-end", id: "answer" },
    { type: "finish", reason: "stop" },
  ]
  const runtime = runtimeWith({
      async *stream() {
        yield* events
      },
  })
  const input: IBuliPromptInput = { sessionId: "session-1", text: "Hello" }
  const view = createSession(runtime)
  const initial = view.getSnapshot()

  await runtime.submitPrompt(input)

  expect(view.getSnapshot()).not.toBe(initial)
  expect(view.getSnapshot().messages.map((message) => message.role)).toEqual([
    "user",
    "assistant",
  ])
  expect(view.getSnapshot().messages[1]?.content).toContainEqual(
    expect.objectContaining({ type: "text", text: "Hello from Buli" }),
  )

  runtime.dispose()
})

test("application runtime ignores blank prompts", async () => {
  const runtime = runtimeWith()
  const view = createSession(runtime)

  await runtime.submitPrompt({ sessionId: "session-1", text: "   " })

  expect(view.getSnapshot().messages).toEqual([])
  runtime.dispose()
})

test("application runtime returns one stable view per session", () => {
  const runtime = runtimeWith()

  const first = createSession(runtime)
  const second = runtime.getAgentSession("session-1")
  const other = createSession(runtime, "session-2")

  expect(second).toBe(first)
  expect(other).not.toBe(first)

  runtime.dispose()
})

test("application runtime applies global selection to the next prompt", async () => {
  const runs: string[] = []
  const runtime = new BuliApplicationRuntime({
    workspaceRoot: WORKSPACE_ROOT,
    manager: new InMemorySessionManager(),
    models: [
      {
        id: "first",
        name: "First",
        reasoningEfforts: ["low", "medium"],
        model: {
          async *stream(request) {
            runs.push(`first:${request.reasoningEffort}`)
            yield { type: "finish", reason: "stop" }
          },
        },
      },
      {
        id: "second",
        name: "Second",
        reasoningEfforts: ["medium", "high"],
        model: {
          async *stream(request) {
            runs.push(`second:${request.reasoningEffort}`)
            yield { type: "finish", reason: "stop" }
          },
        },
      },
    ],
    selection: {
      modelId: "first",
      reasoningEffort: "medium",
    },
  })
  createSession(runtime)
  const initialSnapshot = runtime.getSnapshot()
  let notifications = 0
  const unsubscribe = runtime.subscribe(() => {
    notifications += 1
  })

  await runtime.submitPrompt({ sessionId: "session-1", text: "First" })
  runtime.selectModel("second")
  const modelSnapshot = runtime.getSnapshot()
  await runtime.submitPrompt({ sessionId: "session-1", text: "Second" })
  runtime.selectReasoningEffort("high")
  await runtime.submitPrompt({ sessionId: "session-1", text: "Third" })

  expect(runs).toEqual([
    "first:medium",
    "second:medium",
    "second:high",
  ])
  expect(modelSnapshot).not.toBe(initialSnapshot)
  expect(modelSnapshot.selection).toEqual({
    modelId: "second",
    reasoningEffort: "medium",
  })
  expect(runtime.getSnapshot().selection).toEqual({
    modelId: "second",
    reasoningEffort: "high",
  })
  expect(notifications).toBe(2)
  expect(Object.isFrozen(runtime.getSnapshot())).toBe(true)
  expect(Object.isFrozen(runtime.getSnapshot().models)).toBe(true)
  expect(Object.isFrozen(runtime.getSnapshot().selection)).toBe(true)

  unsubscribe()
  runtime.dispose()
})

test("application runtime rejects invalid selections atomically", () => {
  const runtime = runtimeWith()
  const snapshot = runtime.getSnapshot()
  let notifications = 0
  runtime.subscribe(() => {
    notifications += 1
  })

  runtime.selectModel("test")
  runtime.selectReasoningEffort("medium")

  expect(() => runtime.selectModel("missing")).toThrow(
    "Unknown model: missing",
  )
  expect(() => runtime.selectReasoningEffort("high")).toThrow(
    "Unsupported reasoning effort: high",
  )
  expect(runtime.getSnapshot()).toBe(snapshot)
  expect(notifications).toBe(0)

  runtime.dispose()
})

test("application runtime creates an explicit session once", () => {
  const runtime = runtimeWith()

  const session = runtime.createAgentSession({
    sessionId: "session-1",
    systemPrompt: "Session system prompt",
    tools: [],
  })

  expect(runtime.getAgentSession("session-1")).toBe(session)
  expect(() =>
    runtime.createAgentSession({
      sessionId: "session-1",
      systemPrompt: "Different prompt",
      tools: [],
    })
  ).toThrow("Agent session already exists: session-1")

  runtime.dispose()
})

test("application runtime delegates abort and rejects it after disposal", () => {
  const runtime = runtimeWith()

  expect(() => runtime.abort("session-1")).not.toThrow()

  runtime.dispose()
  expect(() => runtime.abort("session-1")).toThrow(
    "Buli runtime is disposed",
  )
})

test("clears sessions explicitly and treats slash input as prompts", async () => {
  let interactionCount = 0
  const runtime = runtimeWith({
      async *stream() {
        interactionCount += 1
        yield { type: "finish", reason: "stop" }
      },
  })
  const view = createSession(runtime)

  await runtime.submitPrompt({
    sessionId: "session-1",
    text: "Old question",
  })

  expect(interactionCount).toBe(1)
  expect(view.getSnapshot().messages).toHaveLength(2)

  runtime.clearSession("session-1")

  expect(interactionCount).toBe(1)
  expect(view.getSnapshot().messages).toEqual([])

  await runtime.submitPrompt({
    sessionId: "session-1",
    text: "/clear",
  })

  expect(interactionCount).toBe(2)
  expect(view.getSnapshot().messages.map((message) => message.role)).toEqual([
    "user",
    "assistant",
  ])

  runtime.dispose()
})
