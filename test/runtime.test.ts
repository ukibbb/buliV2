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
    model: modelOverride,
    tools: [],
    systemPrompt: "System",
    workspaceRoot: WORKSPACE_ROOT,
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
  const view = runtime.getAgentSession("session-1")
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

  await runtime.submitPrompt({ sessionId: "session-1", text: "   " })

  expect(runtime.getAgentSession("session-1").getSnapshot().messages).toEqual([])
  runtime.dispose()
})

test("application runtime returns one stable view per session", () => {
  const runtime = runtimeWith()

  const first = runtime.getAgentSession("session-1")
  const second = runtime.getAgentSession("session-1")
  const other = runtime.getAgentSession("session-2")

  expect(second).toBe(first)
  expect(other).not.toBe(first)

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

test("handles only exact reset commands locally", async () => {
  let interactionCount = 0
  const runtime = runtimeWith({
      async *stream() {
        interactionCount += 1
        yield { type: "finish", reason: "stop" }
      },
  })
  const view = runtime.getAgentSession("session-1")

  await runtime.submitPrompt({
    sessionId: "session-1",
    text: "Old question",
  })

  expect(interactionCount).toBe(1)
  expect(view.getSnapshot().messages).toHaveLength(2)

  await runtime.submitPrompt({
    sessionId: "session-1",
    text: "  /reset  ",
  })

  expect(interactionCount).toBe(1)
  expect(view.getSnapshot().messages).toEqual([])

  await runtime.submitPrompt({
    sessionId: "session-1",
    text: "/reset now",
  })

  expect(interactionCount).toBe(2)
  expect(view.getSnapshot().messages.map((message) => message.role)).toEqual([
    "user",
    "assistant",
  ])

  runtime.dispose()
})
