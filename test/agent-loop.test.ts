import { expect, test } from "bun:test"

import type {
  IAgentEvent,
  IAgentModel,
  IAgentModelEvent,
  IAgentModelRequest,
  IAgentTool,
} from "@/agent/agent-types"
import { runAgentLoop } from "@/agent/agent-loop"

class ScriptedModel implements IAgentModel {
  readonly requests: IAgentModelRequest[] = []

  constructor(
    private readonly script:
      | readonly IAgentModelEvent[]
      | ((iteration: number) => readonly IAgentModelEvent[]),
  ) {}

  async *stream(request: IAgentModelRequest): AsyncIterable<IAgentModelEvent> {
    const iteration = this.requests.length
    this.requests.push({
      ...request,
      history: structuredClone(request.history),
      tools: structuredClone(request.tools),
    })

    const events = typeof this.script === "function"
      ? this.script(iteration)
      : this.script

    for (const event of events) yield event
  }
}

test("emits an explicit lifecycle for a text response", async () => {
  const model = new ScriptedModel([
    { type: "text-start", id: "answer" },
    { type: "text-delta", id: "answer", delta: "Hello" },
    { type: "text-end", id: "answer" },
    { type: "finish", reason: "stop" },
  ])
  const events: IAgentEvent[] = []

  const result = await runAgentLoop({
    sessionId: "session-1",
    systemPrompt: "System",
    history: [],
    prompt: userMessage("Question"),
    model,
    tools: [],
    signal: new AbortController().signal,
    emit: (event) => {
      events.push(structuredClone(event))
    },
    now: timeGenerator(),
    generateId: idGenerator(),
  })

  expect(events.map((event) => event.type)).toEqual([
    "agent_start",
    "turn_start",
    "message_start",
    "message_end",
    "message_start",
    "message_update",
    "message_update",
    "message_update",
    "message_end",
    "turn_end",
    "agent_end",
  ])
  expect(result.reason).toBe("completed")
  expect(result.messages.at(-1)?.parts).toContainEqual(
    expect.objectContaining({ type: "text", text: "Hello" }),
  )
  expect(model.requests[0]?.history.map((message) => message.info.role)).toEqual([
    "user",
  ])
})

test("executes local tools in the loop and continues with their results", async () => {
  const model = new ScriptedModel((iteration) => iteration === 0
    ? [
        {
          type: "tool-call",
          callID: "call-read",
          tool: "read_file",
          input: { path: "README.md" },
          execution: "local",
        },
        { type: "finish", reason: "tool-calls" },
      ]
    : [
        { type: "text-start", id: "answer" },
        { type: "text-delta", id: "answer", delta: "Finished" },
        { type: "text-end", id: "answer" },
        { type: "finish", reason: "stop" },
      ])
  const toolCalls: string[] = []
  const tool: IAgentTool = {
    name: "read_file",
    description: "Read a file",
    inputSchema: { type: "object" },
    async execute(input, context) {
      toolCalls.push(`${context.toolCallID}:${String(input.path)}`)
      return "contents"
    },
  }
  const events: IAgentEvent[] = []

  const result = await runAgentLoop({
    sessionId: "session-1",
    systemPrompt: "System",
    history: [],
    prompt: userMessage("Read"),
    model,
    tools: [tool],
    signal: new AbortController().signal,
    emit: (event) => {
      events.push(structuredClone(event))
    },
    now: timeGenerator(),
    generateId: idGenerator(),
  })

  expect(toolCalls).toEqual(["call-read:README.md"])
  expect(model.requests).toHaveLength(2)
  expect(model.requests[1]?.history).toHaveLength(2)
  expect(model.requests[1]?.history[1]?.parts).toContainEqual(
    expect.objectContaining({
      type: "tool",
      callID: "call-read",
      status: "completed",
      output: "contents",
    }),
  )
  expect(events.map((event) => event.type)).toContain("tool_execution_start")
  expect(events.map((event) => event.type)).toContain("tool_execution_end")
  expect(result.reason).toBe("completed")
})

test("turns an unknown local tool into a model-visible error", async () => {
  const model = new ScriptedModel((iteration) => iteration === 0
    ? [
        {
          type: "tool-call",
          callID: "call-missing",
          tool: "missing",
          input: {},
          execution: "local",
        },
        { type: "finish", reason: "tool-calls" },
      ]
    : [{ type: "finish", reason: "stop" }])

  await runAgentLoop({
    sessionId: "session-1",
    systemPrompt: "System",
    history: [],
    prompt: userMessage("Run"),
    model,
    tools: [],
    signal: new AbortController().signal,
    emit: () => undefined,
    now: timeGenerator(),
    generateId: idGenerator(),
  })

  expect(model.requests[1]?.history[1]?.parts).toContainEqual(
    expect.objectContaining({
      type: "tool",
      callID: "call-missing",
      status: "error",
      error: "Unknown tool: missing",
    }),
  )
})

test("preserves partial output and cancels open tools on abort", async () => {
  const controller = new AbortController()
  const model: IAgentModel = {
    async *stream() {
      yield {
        type: "tool-call",
        callID: "call-read",
        tool: "read_file",
        input: { path: "README.md" },
        execution: "local",
      }
      yield { type: "text-start", id: "answer" }
      yield { type: "text-delta", id: "answer", delta: "Partial" }
      controller.abort("Stopped by test")
    },
  }

  const result = await runAgentLoop({
    sessionId: "session-1",
    systemPrompt: "System",
    history: [],
    prompt: userMessage("Question"),
    model,
    tools: [],
    signal: controller.signal,
    emit: () => undefined,
    now: timeGenerator(),
    generateId: idGenerator(),
  })

  const assistant = result.messages.at(-1)
  expect(result.reason).toBe("aborted")
  expect(assistant?.info).toMatchObject({
    role: "assistant",
    finish: "abort",
    error: { name: "AbortError", message: "Stopped by test" },
  })
  expect(assistant?.parts).toContainEqual(
    expect.objectContaining({ type: "text", text: "Partial" }),
  )
  expect(assistant?.parts).toContainEqual(
    expect.objectContaining({
      type: "tool",
      callID: "call-read",
      status: "cancelled",
    }),
  )
})

function userMessage(text: string) {
  return {
    info: {
      id: "user-message",
      sessionId: "session-1",
      role: "user" as const,
      createdAt: 1,
    },
    parts: [{
      id: "user-part",
      messageId: "user-message",
      sessionId: "session-1",
      createdAt: 1,
      type: "text" as const,
      text,
    }],
  }
}

function timeGenerator(): () => number {
  let value = 10
  return () => ++value
}

function idGenerator(): () => string {
  let value = 0
  return () => `generated-${++value}`
}
