import { expect, test } from "bun:test"
import { Buffer } from "node:buffer"

import type {
  IAgentEvent,
  IAgentModel,
  IAgentModelEvent,
  IAgentModelRequest,
  IAgentTool,
} from "@/agent/agent-types"
import { runAgentLoop } from "@/agent/agent-loop"
import type { IUserMessage } from "@/domain"

const RUN_ID = "run-1"

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
    runId: RUN_ID,
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
  expect(events.every((event) => event.runId === RUN_ID)).toBe(true)
  expect(result.reason).toBe("completed")
  expect(result.messages.at(-1)).toEqual({
    id: "generated-1",
    sessionId: "session-1",
    runId: RUN_ID,
    role: "assistant",
    content: [{ type: "text", text: "Hello" }],
    stopReason: "stop",
    createdAt: 11,
  })
  expect(model.requests[0]?.messages.map((message) => message.role)).toEqual([
    "user",
  ])
  expect(model.requests[0]?.runId).toBe(RUN_ID)
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
  const executionRunIds: string[] = []
  const readFileTool: IAgentTool = {
    name: "read_file",
    description: "Read a file",
    inputSchema: { type: "object" },
    async execute(input, context) {
      activeToolCalls += 1
      maximumActiveToolCalls = Math.max(maximumActiveToolCalls, activeToolCalls)
      executionOrder.push(`start:${context.toolCallId}`)
      executionRunIds.push(context.runId)
      await Promise.resolve()
      executionOrder.push(`end:${context.toolCallId}`)
      activeToolCalls -= 1
      return `contents:${String(input.path)}`
    },
  }
  const events: IAgentEvent[] = []

  const result = await runAgentLoop({
    sessionId: "session-1",
    runId: RUN_ID,
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
    runId: RUN_ID,
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
    runId: RUN_ID,
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
  expect(executionRunIds).toEqual([RUN_ID, RUN_ID])
  expect(model.requests).toHaveLength(2)
  expect(model.requests.every((request) => request.runId === RUN_ID)).toBe(true)
  expect(model.requests[1]?.messages).toEqual([
    userMessage("Read"),
    {
      id: "generated-1",
      sessionId: "session-1",
      runId: RUN_ID,
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
      runId: RUN_ID,
      toolCallId: "call-readme",
      toolName: "read_file",
      input: { path: "README.md" },
    },
    {
      type: "tool_execution_end",
      runId: RUN_ID,
      toolCallId: "call-readme",
      toolName: "read_file",
      result: readmeResult,
    },
    { type: "message_start", runId: RUN_ID, message: readmeResult },
    { type: "message_end", runId: RUN_ID, message: readmeResult },
    {
      type: "tool_execution_start",
      runId: RUN_ID,
      toolCallId: "call-package",
      toolName: "read_file",
      input: { path: "package.json" },
    },
    {
      type: "tool_execution_end",
      runId: RUN_ID,
      toolCallId: "call-package",
      toolName: "read_file",
      result: packageResult,
    },
    { type: "message_start", runId: RUN_ID, message: packageResult },
    { type: "message_end", runId: RUN_ID, message: packageResult },
  ])
  expect(events.every((event) => event.runId === RUN_ID)).toBe(true)
  expect(result.reason).toBe("completed")
  expect(result.messages.at(-1)).toMatchObject({
    role: "assistant",
    content: [{ type: "text", text: "Finished" }],
    stopReason: "stop",
  })
})

test("injects steering only after the complete tool batch", async () => {
  const order: string[] = []
  const steering: IUserMessage[] = []
  const model = new ScriptedModel((iteration) => {
    order.push(`model:${iteration}`)
    return iteration === 0
      ? [
          {
            type: "tool-call",
            toolCallId: "call-first",
            toolName: "read_file",
            input: { path: "README.md" },
          },
          {
            type: "tool-call",
            toolCallId: "call-second",
            toolName: "read_file",
            input: { path: "package.json" },
          },
          { type: "finish", reason: "tool-calls" },
        ]
      : [{ type: "finish", reason: "stop" }]
  })
  const tool: IAgentTool = {
    name: "read_file",
    description: "Read a file",
    inputSchema: { type: "object" },
    async execute(input) {
      order.push(`tool:${String(input.path)}`)
      return String(input.path)
    },
  }
  const events: IAgentEvent[] = []

  const result = await runAgentLoop({
    sessionId: "session-1",
    runId: RUN_ID,
    systemPrompt: "System",
    messages: [],
    prompt: userMessage("Read both files"),
    model,
    reasoningEffort: "medium",
    tools: [tool],
    signal: new AbortController().signal,
    emit: (event) => {
      events.push(structuredClone(event))
      if (
        event.type === "tool_execution_start"
        && event.toolCallId === "call-first"
      ) {
        steering.push({
          id: "steering-during-tools",
          sessionId: "session-1",
          runId: RUN_ID,
          role: "user",
          source: "steer",
          content: "Check both results",
          createdAt: 3,
        })
      }
    },
    hasSteeringMessages: () => steering.length > 0,
    takeSteeringMessage: () => steering.shift(),
    now: timeGenerator(),
    generateId: idGenerator(),
  })

  expect(order).toEqual([
    "model:0",
    "tool:README.md",
    "tool:package.json",
    "model:1",
  ])
  expect(model.requests[1]?.messages.at(-1)).toMatchObject({
    role: "user",
    source: "steer",
    content: "Check both results",
  })
  const secondToolEnd = events.findIndex((event) =>
    event.type === "tool_execution_end"
    && event.toolCallId === "call-second"
  )
  const firstSteeringStart = events.findIndex((event) =>
    event.type === "message_start"
    && event.message.role === "user"
    && event.message.source === "steer"
  )
  expect(secondToolEnd).toBeGreaterThan(-1)
  expect(firstSteeringStart).toBeGreaterThan(secondToolEnd)
  expect(result.reason).toBe("completed")
})

test("delivers follow-up only after tool continuation and steering", async () => {
  const steering: IUserMessage[] = []
  const followUps: IUserMessage[] = []
  const model = new ScriptedModel((iteration) => iteration === 0
    ? [
        {
          type: "tool-call",
          toolCallId: "call-read",
          toolName: "read_file",
          input: { path: "README.md" },
        },
        { type: "finish", reason: "tool-calls" },
      ]
    : [{ type: "finish", reason: "stop" }])
  const tool: IAgentTool = {
    name: "read_file",
    description: "Read a file",
    inputSchema: { type: "object" },
    execute: async () => "contents",
  }

  const result = await runAgentLoop({
    sessionId: "session-1",
    runId: RUN_ID,
    systemPrompt: "System",
    messages: [],
    prompt: userMessage("Read the file"),
    model,
    reasoningEffort: "medium",
    tools: [tool],
    signal: new AbortController().signal,
    emit: (event) => {
      if (event.type !== "tool_execution_start") return
      steering.push({
        id: "steering-1",
        sessionId: "session-1",
        runId: RUN_ID,
        role: "user",
        source: "steer",
        content: "Check the result first",
        createdAt: 2,
      })
      followUps.push({
        id: "follow-up-1",
        sessionId: "session-1",
        runId: RUN_ID,
        role: "user",
        source: "followUp",
        content: "Then summarize everything",
        createdAt: 3,
      })
    },
    hasSteeringMessages: () => steering.length > 0,
    takeSteeringMessage: () => steering.shift(),
    hasFollowUpMessages: () => followUps.length > 0,
    takeFollowUpMessage: () => followUps.shift(),
    now: timeGenerator(),
    generateId: idGenerator(),
  })

  expect(model.requests).toHaveLength(3)
  expect(model.requests[1]?.messages.at(-1)).toMatchObject({
    source: "steer",
    content: "Check the result first",
  })
  expect(model.requests[1]?.messages).not.toContainEqual(
    expect.objectContaining({ source: "followUp" }),
  )
  expect(model.requests[2]?.messages.at(-1)).toMatchObject({
    source: "followUp",
    content: "Then summarize everything",
  })
  expect(result.messages.filter((message) => message.role === "user").map(
    (message) => message.source,
  )).toEqual(["prompt", "steer", "followUp"])
  expect(result.reason).toBe("completed")
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
    runId: RUN_ID,
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
    runId: RUN_ID,
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
    runId: RUN_ID,
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
    runId: RUN_ID,
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

test("gives abort precedence over an iteration limit during turn_end", async () => {
  const controller = new AbortController()
  const model = new ScriptedModel([
    {
      type: "tool-call",
      toolCallId: "call-read",
      toolName: "read_file",
      input: { path: "README.md" },
    },
    { type: "finish", reason: "tool-calls" },
  ])
  const tool: IAgentTool = {
    name: "read_file",
    description: "Read a file",
    inputSchema: { type: "object" },
    execute: async () => "contents",
  }

  const result = await runAgentLoop({
    sessionId: "session-1",
    runId: RUN_ID,
    systemPrompt: "System",
    messages: [],
    prompt: userMessage("Read"),
    model,
    reasoningEffort: "medium",
    tools: [tool],
    signal: controller.signal,
    emit: (event) => {
      if (event.type === "turn_end") controller.abort("Stopped during turn_end")
    },
    maxProviderIterations: 1,
    now: timeGenerator(),
    generateId: idGenerator(),
  })

  expect(result.reason).toBe("aborted")
})

test("gives abort precedence over a provider error during turn_end", async () => {
  const controller = new AbortController()
  const model = new ScriptedModel([{
    type: "error",
    error: new Error("Provider failed"),
  }])

  const result = await runAgentLoop({
    sessionId: "session-1",
    runId: RUN_ID,
    systemPrompt: "System",
    messages: [],
    prompt: userMessage("Question"),
    model,
    reasoningEffort: "medium",
    tools: [],
    signal: controller.signal,
    emit: (event) => {
      if (event.type === "turn_end") controller.abort("Stopped during turn_end")
    },
    now: timeGenerator(),
    generateId: idGenerator(),
  })

  expect(result.reason).toBe("aborted")
})

test("rejects duplicate tool names before starting the model", async () => {
  const model = new ScriptedModel([{ type: "finish", reason: "stop" }])
  const duplicate: IAgentTool = {
    name: "read_file",
    description: "Read",
    inputSchema: { type: "object" },
    execute: async () => "unused",
  }
  const events: IAgentEvent[] = []

  await expect(runAgentLoop({
    sessionId: "session-1",
    runId: RUN_ID,
    systemPrompt: "System",
    messages: [],
    prompt: userMessage("Question"),
    model,
    reasoningEffort: "medium",
    tools: [duplicate, { ...duplicate }],
    signal: new AbortController().signal,
    emit: (event) => {
      events.push(event)
    },
  })).rejects.toThrow("Duplicate tool: read_file")

  expect(model.requests).toHaveLength(0)
  expect(events).toHaveLength(0)
})

test("turns invalid tool input into a model-visible result without executing", async () => {
  const model = new ScriptedModel((iteration) => iteration === 0
    ? [
        {
          type: "tool-call",
          toolCallId: "invalid-read",
          toolName: "read_file",
          input: { path: 42, extra: true },
        },
        { type: "finish", reason: "tool-calls" },
      ]
    : [{ type: "finish", reason: "stop" }])
  let executionCount = 0
  const tool: IAgentTool = {
    name: "read_file",
    description: "Read",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", minLength: 1 } },
      required: ["path"],
      additionalProperties: false,
    },
    execute: async () => {
      executionCount += 1
      return "unused"
    },
  }

  const result = await runAgentLoop({
    sessionId: "session-1",
    runId: RUN_ID,
    systemPrompt: "System",
    messages: [],
    prompt: userMessage("Read"),
    model,
    reasoningEffort: "medium",
    tools: [tool],
    signal: new AbortController().signal,
    emit: () => {},
    now: timeGenerator(),
    generateId: idGenerator(),
  })

  const toolResult = result.messages.find((message) => message.role === "toolResult")
  expect(executionCount).toBe(0)
  expect(toolResult).toMatchObject({
    role: "toolResult",
    toolCallId: "invalid-read",
    isError: true,
    content: expect.stringContaining('Invalid input for tool "read_file"'),
  })
  expect(model.requests[1]?.messages).toContainEqual(toolResult)
})

test("serializes tool progress before the final result and ignores late updates", async () => {
  const model = new ScriptedModel((iteration) => iteration === 0
    ? [
        {
          type: "tool-call",
          toolCallId: "progress-call",
          toolName: "scan",
          input: {},
        },
        { type: "finish", reason: "tool-calls" },
      ]
    : [{ type: "finish", reason: "stop" }])
  let lateProgress: ((progress: string) => void) | undefined
  const tool: IAgentTool = {
    name: "scan",
    description: "Scan",
    inputSchema: { type: "object", additionalProperties: false },
    execute: async (_input, context) => {
      lateProgress = context.reportProgress
      context.reportProgress?.("first")
      await Promise.resolve()
      context.reportProgress?.("second")
      return "complete"
    },
  }
  const events: IAgentEvent[] = []

  await runAgentLoop({
    sessionId: "session-1",
    runId: RUN_ID,
    systemPrompt: "System",
    messages: [],
    prompt: userMessage("Scan"),
    model,
    reasoningEffort: "medium",
    tools: [tool],
    signal: new AbortController().signal,
    emit: async (event) => {
      await Promise.resolve()
      events.push(structuredClone(event))
    },
    now: timeGenerator(),
    generateId: idGenerator(),
  })
  lateProgress?.("late")
  await Promise.resolve()

  expect(events.filter((event) => event.type.startsWith("tool_execution")))
    .toEqual([
      {
        type: "tool_execution_start",
        runId: RUN_ID,
        toolCallId: "progress-call",
        toolName: "scan",
        input: {},
      },
      {
        type: "tool_execution_update",
        runId: RUN_ID,
        toolCallId: "progress-call",
        toolName: "scan",
        progress: "first",
      },
      {
        type: "tool_execution_update",
        runId: RUN_ID,
        toolCallId: "progress-call",
        toolName: "scan",
        progress: "second",
      },
      expect.objectContaining({
        type: "tool_execution_end",
        toolCallId: "progress-call",
      }),
    ])
})

test("truncates custom tool output before persistence and model continuation", async () => {
  const model = new ScriptedModel((iteration) => iteration === 0
    ? [
        {
          type: "tool-call",
          toolCallId: "large-call",
          toolName: "large",
          input: {},
        },
        { type: "finish", reason: "tool-calls" },
      ]
    : [{ type: "finish", reason: "stop" }])
  const tool: IAgentTool = {
    name: "large",
    description: "Large output",
    inputSchema: { type: "object", additionalProperties: false },
    execute: async () => "x".repeat(100_001),
  }

  const result = await runAgentLoop({
    sessionId: "session-1",
    runId: RUN_ID,
    systemPrompt: "System",
    messages: [],
    prompt: userMessage("Run"),
    model,
    reasoningEffort: "medium",
    tools: [tool],
    signal: new AbortController().signal,
    emit: () => {},
    now: timeGenerator(),
    generateId: idGenerator(),
  })

  const persisted = result.messages.find((message) => message.role === "toolResult")
  const continued = model.requests[1]?.messages.find(
    (message) => message.role === "toolResult",
  )
  if (persisted?.role !== "toolResult") throw new Error("Expected tool result")
  if (continued?.role !== "toolResult") throw new Error("Expected continued result")
  expect(persisted).toEqual(continued)
  expect(persisted.content).toEndWith("... output truncated")
  expect(Buffer.byteLength(persisted.content, "utf8")).toBeLessThanOrEqual(
    100_000,
  )
})

function userMessage(text: string) {
  return {
    id: "user-message",
    sessionId: "session-1",
    runId: RUN_ID,
    role: "user" as const,
    source: "prompt" as const,
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
