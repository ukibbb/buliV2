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
      messages: structuredClone(request.messages),
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
    messages: [],
    prompt: userMessage("Question"),
    model,
    reasoningEffort: "medium",
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
  expect(result.messages.at(-1)).toEqual({
    id: "generated-1",
    sessionId: "session-1",
    role: "assistant",
    content: [{ type: "text", text: "Hello" }],
    stopReason: "stop",
    createdAt: 11,
  })
  expect(model.requests[0]?.messages.map((message) => message.role)).toEqual([
    "user",
  ])
})

test("executes multiple tools sequentially and emits each result lifecycle", async () => {
  const model = new ScriptedModel((iteration) => iteration === 0
    ? [
        {
          type: "tool-call",
          toolCallId: "call-readme",
          toolName: "read_file",
          input: { path: "README.md" },
        },
        {
          type: "tool-call",
          toolCallId: "call-package",
          toolName: "read_file",
          input: { path: "package.json" },
        },
        { type: "finish", reason: "tool-calls" },
      ]
    : [
        { type: "text-start", id: "answer" },
        { type: "text-delta", id: "answer", delta: "Finished" },
        { type: "text-end", id: "answer" },
        { type: "finish", reason: "stop" },
      ])
  const executionOrder: string[] = []
  let activeToolCalls = 0
  let maximumActiveToolCalls = 0
  const readFileTool: IAgentTool = {
    name: "read_file",
    description: "Read a file",
    inputSchema: { type: "object" },
    async execute(input, context) {
      activeToolCalls += 1
      maximumActiveToolCalls = Math.max(maximumActiveToolCalls, activeToolCalls)
      executionOrder.push(`start:${context.toolCallId}`)
      await Promise.resolve()
      executionOrder.push(`end:${context.toolCallId}`)
      activeToolCalls -= 1
      return `contents:${String(input.path)}`
    },
  }
  const events: IAgentEvent[] = []

  const result = await runAgentLoop({
    sessionId: "session-1",
    systemPrompt: "System",
    messages: [],
    prompt: userMessage("Read"),
    model,
    reasoningEffort: "medium",
    tools: [readFileTool],
    signal: new AbortController().signal,
    emit: (event) => {
      events.push(structuredClone(event))
    },
    now: timeGenerator(),
    generateId: idGenerator(),
  })

  const readmeResult = {
    id: "generated-2",
    sessionId: "session-1",
    role: "toolResult" as const,
    toolCallId: "call-readme",
    toolName: "read_file",
    content: "contents:README.md",
    isError: false,
    createdAt: 12,
  }
  const packageResult = {
    id: "generated-3",
    sessionId: "session-1",
    role: "toolResult" as const,
    toolCallId: "call-package",
    toolName: "read_file",
    content: "contents:package.json",
    isError: false,
    createdAt: 13,
  }

  expect(executionOrder).toEqual([
    "start:call-readme",
    "end:call-readme",
    "start:call-package",
    "end:call-package",
  ])
  expect(maximumActiveToolCalls).toBe(1)
  expect(model.requests).toHaveLength(2)
  expect(model.requests[1]?.messages).toEqual([
    userMessage("Read"),
    {
      id: "generated-1",
      sessionId: "session-1",
      role: "assistant",
      content: [
        {
          type: "toolCall",
          toolCallId: "call-readme",
          toolName: "read_file",
          input: { path: "README.md" },
        },
        {
          type: "toolCall",
          toolCallId: "call-package",
          toolName: "read_file",
          input: { path: "package.json" },
        },
      ],
      stopReason: "tool-calls",
      createdAt: 11,
    },
    readmeResult,
    packageResult,
  ])
  expect(events.filter((event) =>
    event.type === "tool_execution_start"
    || event.type === "tool_execution_end"
    || (
      (event.type === "message_start" || event.type === "message_end")
      && event.message.role === "toolResult"
    )
  )).toEqual([
    {
      type: "tool_execution_start",
      toolCallId: "call-readme",
      toolName: "read_file",
      input: { path: "README.md" },
    },
    {
      type: "tool_execution_end",
      toolCallId: "call-readme",
      toolName: "read_file",
      result: readmeResult,
    },
    { type: "message_start", message: readmeResult },
    { type: "message_end", message: readmeResult },
    {
      type: "tool_execution_start",
      toolCallId: "call-package",
      toolName: "read_file",
      input: { path: "package.json" },
    },
    {
      type: "tool_execution_end",
      toolCallId: "call-package",
      toolName: "read_file",
      result: packageResult,
    },
    { type: "message_start", message: packageResult },
    { type: "message_end", message: packageResult },
  ])
  expect(result.reason).toBe("completed")
  expect(result.messages.at(-1)).toMatchObject({
    role: "assistant",
    content: [{ type: "text", text: "Finished" }],
    stopReason: "stop",
  })
})

test("turns an unknown local tool into a model-visible error", async () => {
  const model = new ScriptedModel((iteration) => iteration === 0
    ? [
        {
          type: "tool-call",
          toolCallId: "call-missing",
          toolName: "missing",
          input: {},
        },
        { type: "finish", reason: "tool-calls" },
      ]
    : [{ type: "finish", reason: "stop" }])

  await runAgentLoop({
    sessionId: "session-1",
    systemPrompt: "System",
    messages: [],
    prompt: userMessage("Run"),
    model,
    reasoningEffort: "medium",
    tools: [],
    signal: new AbortController().signal,
    emit: () => undefined,
    now: timeGenerator(),
    generateId: idGenerator(),
  })

  expect(model.requests[1]?.messages.at(-1)).toEqual({
    id: "generated-2",
    sessionId: "session-1",
    role: "toolResult",
    toolCallId: "call-missing",
    toolName: "missing",
    content: "Unknown tool: missing",
    isError: true,
    createdAt: 12,
  })
})

test("gives abort precedence over a racing provider finish", async () => {
  const controller = new AbortController()
  const model: IAgentModel = {
    async *stream() {
      yield {
        type: "tool-call",
        toolCallId: "call-read",
        toolName: "read_file",
        input: { path: "README.md" },
      }
      yield { type: "text-start", id: "answer" }
      yield { type: "text-delta", id: "answer", delta: "Partial" }
      controller.abort("Stopped by test")
      yield { type: "finish", reason: "stop" }
    },
  }

  const result = await runAgentLoop({
    sessionId: "session-1",
    systemPrompt: "System",
    messages: [],
    prompt: userMessage("Question"),
    model,
    reasoningEffort: "medium",
    tools: [],
    signal: controller.signal,
    emit: () => undefined,
    now: timeGenerator(),
    generateId: idGenerator(),
  })

  const assistant = result.messages.at(-1)
  expect(result.reason).toBe("aborted")
  expect(assistant).toEqual({
    id: "generated-1",
    sessionId: "session-1",
    role: "assistant",
    content: [
      {
        type: "toolCall",
        toolCallId: "call-read",
        toolName: "read_file",
        input: { path: "README.md" },
      },
      { type: "text", text: "Partial" },
    ],
    stopReason: "aborted",
    errorMessage: "Stopped by test",
    createdAt: 11,
  })
})

function userMessage(text: string) {
  return {
    id: "user-message",
    sessionId: "session-1",
    role: "user" as const,
    content: text,
    createdAt: 1,
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
