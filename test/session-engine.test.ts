import { expect, test } from "bun:test"
import type {
  IBuliUserInteractionRequest,
  IInteractionEvent,
  IUserBuliInteractionDriver,
} from "@/engine/interaction-driver"
import { SessionEngine } from "@/engine/session-engine"
import { InMemorySessionStore } from "@/engine/session-store"

class ScriptedDriver implements IUserBuliInteractionDriver {
  readonly requests: IBuliUserInteractionRequest[] = []

  constructor(private readonly events: readonly IInteractionEvent[]) {}

  async *interaction(
    request: IBuliUserInteractionRequest,
  ): AsyncIterable<IInteractionEvent> {
    this.requests.push(structuredClone(request))

    for (const event of this.events) {
      yield event
    }
  }
}

test("publishes user input before sending history to the driver", async () => {
  const driver = new ScriptedDriver([
    { type: "text-start", id: "answer" },
    { type: "text-delta", id: "answer", delta: "Hello " },
    { type: "text-delta", id: "answer", delta: "from Buli" },
    { type: "text-end", id: "answer" },
    { type: "finish", reason: "stop" },
  ])
  const store = new InMemorySessionStore()
  const engine = new SessionEngine({
    driver,
    store,
    now: timeGenerator(),
  })

  const assistant = await engine.prompt({
    sessionId: "session-1",
    parts: [{ type: "text", text: "Hello" }],
  })

  expect(
    driver.requests[0]?.history.map((message) => message.info.role),
  ).toEqual(["user"])
  expect(assistant).toMatchObject({
    role: "assistant",
    finish: "stop",
  })

  const history = store.getHistory("session-1")
  expect(history.map((message) => message.info.role)).toEqual([
    "user",
    "assistant",
  ])
  expect(
    history[1]?.parts.find((part) => part.type === "text"),
  ).toMatchObject({
    type: "text",
    text: "Hello from Buli",
  })
})

test("keeps text and reasoning stream IDs independent", async () => {
  const driver = new ScriptedDriver([
    { type: "reasoning-start", id: "shared" },
    { type: "text-start", id: "shared" },
    { type: "reasoning-delta", id: "shared", delta: "Thinking" },
    { type: "text-delta", id: "shared", delta: "Answer" },
    { type: "reasoning-end", id: "shared" },
    { type: "text-end", id: "shared" },
    { type: "finish", reason: "stop" },
  ])
  const store = new InMemorySessionStore()
  const engine = new SessionEngine({
    driver,
    store,
    now: timeGenerator(),
  })

  await engine.prompt({
    sessionId: "session-1",
    parts: [{ type: "text", text: "Explain" }],
  })

  const response = store.getHistory("session-1")[1]
  expect(
    response?.parts.find((part) => part.type === "reasoning"),
  ).toMatchObject({ text: "Thinking" })
  expect(
    response?.parts.find((part) => part.type === "text"),
  ).toMatchObject({ text: "Answer" })
})

test("preserves partial Buli output after an error", async () => {
  const driver = new ScriptedDriver([
    { type: "text-start", id: "answer" },
    { type: "text-delta", id: "answer", delta: "Partial answer" },
    { type: "error", error: new Error("Provider failed") },
  ])
  const store = new InMemorySessionStore()
  const engine = new SessionEngine({
    driver,
    store,
    now: timeGenerator(),
  })

  const assistant = await engine.prompt({
    sessionId: "session-1",
    parts: [{ type: "text", text: "Question" }],
  })

  expect(assistant).toMatchObject({
    role: "assistant",
    finish: "error",
    error: {
      name: "Error",
      message: "Provider failed",
    },
  })
  expect(
    store
      .getHistory("session-1")[1]
      ?.parts.find((part) => part.type === "text"),
  ).toMatchObject({ text: "Partial answer" })
})

test("ignores prompts without semantic parts", async () => {
  const driver = new ScriptedDriver([])
  const store = new InMemorySessionStore()
  const engine = new SessionEngine({ driver, store })

  const assistant = await engine.prompt({
    sessionId: "session-1",
    parts: [{ type: "text", text: "   " }],
  })

  expect(assistant).toBeUndefined()
  expect(driver.requests).toHaveLength(0)
  expect(store.getHistory("session-1")).toEqual([])
})

function timeGenerator(): () => number {
  let next = 100

  return () => {
    next += 1
    return next
  }
}
