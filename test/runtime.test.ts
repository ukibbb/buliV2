import { expect, test } from "bun:test"
import {
  BuliApplicationRuntime,
  type IBuliPromptInput,
} from "@/application"
import type {
  IInteractionEvent,
  IUserBuliInteractionDriver,
} from "@/engine/interaction-driver"
import { SessionEngine } from "@/engine/session-engine"

const WORKSPACE_ROOT = "/workspace"

const driver: IUserBuliInteractionDriver = {
  async *interaction() {},
}

test("application runtime submits prompts into its session view", async () => {
  const events: IInteractionEvent[] = [
    { type: "text-start", id: "answer" },
    { type: "text-delta", id: "answer", delta: "Hello from Buli" },
    { type: "text-end", id: "answer" },
    { type: "finish", reason: "stop" },
  ]
  const sessions = new SessionEngine({
    driver: {
      async *interaction() {
        yield* events
      },
    },
  })
  const runtime = new BuliApplicationRuntime({
    sessions,
    workspaceRoot: WORKSPACE_ROOT,
  })
  const input: IBuliPromptInput = { sessionId: "session-1", text: "Hello" }
  const view = runtime.view("session-1")
  const initial = view.getSnapshot()

  await runtime.submitPrompt(input)

  expect(view.getSnapshot()).not.toBe(initial)
  expect(view.getSnapshot().messages.map((message) => message.info.role)).toEqual([
    "user",
    "assistant",
  ])
  expect(view.getSnapshot().messages[1]?.parts).toContainEqual(
    expect.objectContaining({ type: "text", text: "Hello from Buli" }),
  )

  runtime.dispose()
})

test("application runtime ignores blank prompts", async () => {
  const sessions = new SessionEngine({ driver })
  const runtime = new BuliApplicationRuntime({
    sessions,
    workspaceRoot: WORKSPACE_ROOT,
  })

  await runtime.submitPrompt({ sessionId: "session-1", text: "   " })

  expect(runtime.view("session-1").getSnapshot().messages).toEqual([])
  runtime.dispose()
})

test("application runtime returns one stable view per session", () => {
  const sessions = new SessionEngine({ driver })
  const runtime = new BuliApplicationRuntime({
    sessions,
    workspaceRoot: WORKSPACE_ROOT,
  })

  const first = runtime.view("session-1")
  const second = runtime.view("session-1")
  const other = runtime.view("session-2")

  expect(second).toBe(first)
  expect(other).not.toBe(first)

  runtime.dispose()
})

test("application runtime delegates abort and rejects it after disposal", () => {
  const sessions = new SessionEngine({ driver })
  const runtime = new BuliApplicationRuntime({
    sessions,
    workspaceRoot: WORKSPACE_ROOT,
  })

  expect(() => runtime.abort("session-1")).not.toThrow()

  runtime.dispose()
  expect(() => runtime.abort("session-1")).toThrow(
    "Buli runtime is disposed",
  )
})

test("handles only exact reset commands locally", async () => {
  let interactionCount = 0
  const sessions = new SessionEngine({
    driver: {
      async *interaction() {
        interactionCount += 1
        yield { type: "finish", reason: "stop" }
      },
    },
  })
  const runtime = new BuliApplicationRuntime({
    sessions,
    workspaceRoot: WORKSPACE_ROOT,
  })
  const view = runtime.view("session-1")

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
  expect(view.getSnapshot().messages.map((message) => message.info.role)).toEqual([
    "user",
    "assistant",
  ])

  runtime.dispose()
})
