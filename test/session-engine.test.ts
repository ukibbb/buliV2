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

  constructor(
    private readonly events:
      | readonly IInteractionEvent[]
      | ((iteration: number) => readonly IInteractionEvent[]),
  ) {}

  async *interaction(
    request: IBuliUserInteractionRequest,
  ): AsyncIterable<IInteractionEvent> {
    const iteration = this.requests.length
    this.requests.push({
      ...request,
      history: structuredClone(request.history),
    })

    const events = typeof this.events === "function"
      ? this.events(iteration)
      : this.events

    for (const event of events) {
      yield event
    }
  }
}

test("publishes user input and continues after a local tool", async () => {
  const driver = new ScriptedDriver((iteration) => iteration === 0
    ? [
        {
          type: "tool-call",
          callID: "call-glob",
          tool: "glob",
          input: { pattern: "package.json" },
          execution: "local",
        },
        {
          type: "tool-result",
          callID: "call-glob",
          tool: "glob",
          input: { pattern: "package.json" },
          output: "package.json",
          execution: "local",
        },
        { type: "finish", reason: "tool-calls" },
      ]
    : [
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
  expect(
    driver.requests[1]?.history.map((message) => message.info.role),
  ).toEqual(["user", "assistant"])
  expect(driver.requests).toHaveLength(2)
  expect(assistant).toMatchObject({
    role: "assistant",
    finish: "stop",
  })

  const history = store.getHistory("session-1")
  expect(history.map((message) => message.info.role)).toEqual([
    "user",
    "assistant",
    "assistant",
  ])
  expect(
    history[2]?.parts.find((part) => part.type === "text"),
  ).toMatchObject({
    type: "text",
    text: "Hello from Buli",
  })
  expect(
    history[1]?.parts.find((part) => part.type === "tool"),
  ).toMatchObject({
    type: "tool",
    callID: "call-glob",
    tool: "glob",
    status: "completed",
    input: { pattern: "package.json" },
    output: "package.json",
    execution: "local",
  })
})

test("continues after a local tool error", async () => {
  const driver = new ScriptedDriver((iteration) => iteration === 0
    ? [
        {
          type: "tool-call",
          callID: "call-read",
          tool: "read_file",
          input: { path: "missing.ts" },
          execution: "local",
        },
        {
          type: "tool-error",
          callID: "call-read",
          tool: "read_file",
          input: { path: "missing.ts" },
          error: "File not found",
          execution: "local",
        },
        { type: "finish", reason: "tool-calls" },
      ]
    : [
        { type: "text-start", id: "answer" },
        { type: "text-delta", id: "answer", delta: "The file is missing" },
        { type: "text-end", id: "answer" },
        { type: "finish", reason: "stop" },
      ])
  const store = new InMemorySessionStore()
  const engine = new SessionEngine({ driver, store, now: timeGenerator() })

  const assistant = await engine.prompt({
    sessionId: "session-1",
    parts: [{ type: "text", text: "Read the file" }],
  })

  expect(driver.requests).toHaveLength(2)
  expect(
    store
      .getHistory("session-1")[1]
      ?.parts.find((part) => part.type === "tool"),
  ).toMatchObject({
    status: "error",
    error: "File not found",
  })
  expect(assistant).toMatchObject({ finish: "stop" })
  expect(
    store
      .getHistory("session-1")[2]
      ?.parts.find((part) => part.type === "text"),
  ).toMatchObject({ text: "The file is missing" })
})

test("stops after five provider iterations", async () => {
  const driver = new ScriptedDriver((iteration) => [
    {
      type: "tool-call",
      callID: `call-${iteration}`,
      tool: "glob",
      input: { pattern: `file-${iteration}.ts` },
      execution: "local",
    },
    {
      type: "tool-result",
      callID: `call-${iteration}`,
      tool: "glob",
      input: { pattern: `file-${iteration}.ts` },
      output: `file-${iteration}.ts`,
      execution: "local",
    },
    { type: "finish", reason: "tool-calls" },
  ])
  const store = new InMemorySessionStore()
  const engine = new SessionEngine({ driver, store, now: timeGenerator() })

  const assistant = await engine.prompt({
    sessionId: "session-1",
    parts: [{ type: "text", text: "Keep searching" }],
  })

  expect(driver.requests).toHaveLength(5)
  expect(driver.requests.map((request) => request.history.length)).toEqual([
    1,
    2,
    3,
    4,
    5,
  ])
  expect(store.getHistory("session-1")).toHaveLength(6)
  expect(assistant).toMatchObject({ finish: "tool-calls" })
  expect(
    store
      .getHistory("session-1")[5]
      ?.parts.find((part) => part.type === "tool"),
  ).toMatchObject({ callID: "call-4", status: "completed" })
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
    {
      type: "tool-call",
      callID: "call-read",
      tool: "read_file",
      input: { path: "missing.ts" },
      execution: "local",
    },
    {
      type: "tool-error",
      callID: "call-read",
      tool: "read_file",
      input: { path: "missing.ts" },
      error: "File not found",
      execution: "local",
    },
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
  expect(
    store
      .getHistory("session-1")[1]
      ?.parts.find((part) => part.type === "tool"),
  ).toMatchObject({
    tool: "read_file",
    status: "error",
    error: "File not found",
  })
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

test("aborts partial output, rejects overlap, and releases the session", async () => {
  const firstInteractionStarted = Promise.withResolvers<void>()
  const requests: IBuliUserInteractionRequest[] = []
  const driver: IUserBuliInteractionDriver = {
    async *interaction(request) {
      requests.push(request)

      if (requests.length === 1) {
        yield {
          type: "tool-call",
          callID: "call-grep",
          tool: "grep",
          input: { pattern: "answer" },
          execution: "local",
        }
        yield { type: "text-start", id: "answer" }
        yield { type: "text-delta", id: "answer", delta: "Partial answer" }
        firstInteractionStarted.resolve()
        await new Promise<void>((resolve) => {
          if (request.signal.aborted) return resolve()
          request.signal.addEventListener("abort", () => resolve(), { once: true })
        })
        yield { type: "abort", reason: String(request.signal.reason) }
        return
      }

      yield { type: "text-start", id: "answer" }
      yield { type: "text-delta", id: "answer", delta: "Next answer" }
      yield { type: "text-end", id: "answer" }
      yield { type: "finish", reason: "stop" }
    },
  }
  const store = new InMemorySessionStore()
  const engine = new SessionEngine({ driver, store, now: timeGenerator() })
  const firstPrompt = engine.prompt({
    sessionId: "session-1",
    parts: [{ type: "text", text: "First question" }],
  })
  await firstInteractionStarted.promise

  await expect(engine.prompt({
    sessionId: "session-1",
    parts: [{ type: "text", text: "Overlapping question" }],
  })).rejects.toThrow("A prompt is already running for session session-1")
  expect(store.getHistory("session-1")).toHaveLength(2)

  engine.abort("session-1")
  const abortedAssistant = await firstPrompt

  expect(requests[0]?.signal.aborted).toBe(true)
  expect(abortedAssistant).toMatchObject({
    role: "assistant",
    finish: "abort",
    error: {
      name: "AbortError",
      message: "Buli interaction was aborted",
    },
  })
  expect(
    store
      .getHistory("session-1")[1]
      ?.parts.find((part) => part.type === "text"),
  ).toMatchObject({ text: "Partial answer" })
  expect(
    store
      .getHistory("session-1")[1]
      ?.parts.find((part) => part.type === "tool"),
  ).toMatchObject({
    tool: "grep",
    status: "cancelled",
    error: "Buli interaction was aborted",
  })

  const nextAssistant = await engine.prompt({
    sessionId: "session-1",
    parts: [{ type: "text", text: "Next question" }],
  })
  expect(nextAssistant).toMatchObject({ finish: "stop" })
  expect(requests[1]?.signal.aborted).toBe(false)
  expect(() => engine.abort("idle-session")).not.toThrow()
})

function timeGenerator(): () => number {
  let next = 100

  return () => {
    next += 1
    return next
  }
}
