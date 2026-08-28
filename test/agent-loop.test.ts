import { expect, test } from "bun:test"
import { Buffer } from "node:buffer"
import { Type } from "typebox"

import type {
  TAgentEvent,
  IAgentInputQueue,
  IAgentModel,
  TAgentModelEvent,
  IAgentModelRequest,
  IAgentTool,
  IAgentToolContext,
  IToolOutputStore,
  IUserMessage,
} from "@/agent"
import { runAgentLoop } from "@/agent"
import { EphemeralToolOutputStore } from "@/tools"

const RUN_ID = "run-1"

class ScriptedModel implements IAgentModel {
  readonly requests: IAgentModelRequest[] = []

  constructor(
    private readonly script:
      | readonly TAgentModelEvent[]
      | ((iteration: number) => readonly TAgentModelEvent[]),
  ) {}

  async *stream(request: IAgentModelRequest): AsyncIterable<TAgentModelEvent> {
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
  const events: TAgentEvent[] = []

  const result = await runAgentLoop(
    userMessage("Question"),
    {
      systemPrompt: "System",
      messages: [],
      tools: [],
    },
    {
      sessionId: "session-1",
      runId: RUN_ID,
      model,
      reasoningEffort: "medium",
      signal: new AbortController().signal,
      emit: (event) => {
        events.push(structuredClone(event))
      },
      now: timeGenerator(),
      generateId: idGenerator(),
    },
  )

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
  const executionMessages: Array<readonly unknown[] | undefined> = []
  const readFileTool: IAgentTool = {
    name: "read_file",
    description: "Read a file",
    inputSchema: { type: "object" },
    async execute(input, context) {
      activeToolCalls += 1
      maximumActiveToolCalls = Math.max(maximumActiveToolCalls, activeToolCalls)
      executionOrder.push(`start:${context.toolCallId}`)
      executionRunIds.push(context.runId)
      executionMessages.push(context.messages)
      await Promise.resolve()
      executionOrder.push(`end:${context.toolCallId}`)
      activeToolCalls -= 1
      return `contents:${String(input.path)}`
    },
  }
  const events: TAgentEvent[] = []

  const result = await runAgentLoop(
    userMessage("Read"),
    {
      systemPrompt: "System",
      messages: [],
      tools: [readFileTool],
    },
    {
      sessionId: "session-1",
      runId: RUN_ID,
      model,
      reasoningEffort: "medium",
      signal: new AbortController().signal,
      emit: (event) => {
        events.push(structuredClone(event))
      },
      now: timeGenerator(),
      generateId: idGenerator(),
    },
  )

  const readmeResult = {
    id: "generated-2",
    sessionId: "session-1",
    runId: RUN_ID,
    role: "toolResult" as const,
    toolCallId: "call-readme",
    toolName: "read_file",
    content: "contents:README.md",
    isError: false,
    outcome: "completed" as const,
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
    outcome: "completed" as const,
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
  expect(executionMessages).toEqual([undefined, undefined])
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

test("does not execute tool calls from an output-limited response", async () => {
  const model = new ScriptedModel((iteration) => iteration === 0
    ? [
        {
          type: "tool-call",
          toolCallId: "call-truncated",
          toolName: "write_something",
          input: { content: "apparently valid but truncated" },
        },
        { type: "finish", reason: "length" },
      ]
    : [{ type: "finish", reason: "stop" }])
  let executions = 0
  const tool: IAgentTool = {
    name: "write_something",
    description: "Mutate external state",
    inputSchema: { type: "object" },
    execute: async () => {
      executions += 1
      return "mutated"
    },
  }

  const result = await runAgentLoop(
    userMessage("Write"),
    {
      systemPrompt: "System",
      messages: [],
      tools: [tool],
    },
    {
      sessionId: "session-1",
      runId: RUN_ID,
      model,
      reasoningEffort: "medium",
      signal: new AbortController().signal,
      emit: () => undefined,
      now: timeGenerator(),
      generateId: idGenerator(),
    },
  )

  expect(executions).toBe(0)
  expect(model.requests).toHaveLength(2)
  expect(result.messages.find((message) => message.role === "toolResult"))
    .toMatchObject({
      toolCallId: "call-truncated",
      isError: true,
      content: expect.stringContaining("output token limit"),
    })
})

test("supplies session, model, and conversation context to host tools", async () => {
  let iteration = 0
  const model: IAgentModel = {
    async *stream(request) {
      request.reportProviderAccountId?.("account-context")
      const events: readonly TAgentModelEvent[] = iteration++ === 0
        ? [
            {
              type: "tool-call",
              toolCallId: "call-context",
              toolName: "inspect_context",
              input: {},
            },
            { type: "finish", reason: "tool-calls" },
          ]
        : [{ type: "finish", reason: "stop" }]
      for (const event of events) yield event
    },
  }
  let observedContext: IAgentToolContext | undefined
  const tool: IAgentTool = {
    name: "inspect_context",
    description: "Inspect host context",
    inputSchema: { type: "object", additionalProperties: false },
    requiresConversationContext: true,
    execute: async (_input, context) => {
      observedContext = context
      return "inspected"
    },
  }

  await runAgentLoop(
    {
      ...userMessage("Current question"),
      sessionId: "session-context",
    },
    {
      systemPrompt: "System",
      messages: [userMessage("Previous question")],
      tools: [tool],
    },
    {
      sessionId: "session-context",
      runId: RUN_ID,
      model,
      modelProfile: {
        providerId: "openai",
        modelId: "gpt-5.6-sol",
        contextWindowTokens: 128_000,
      },
      reasoningEffort: "medium",
      signal: new AbortController().signal,
      emit: () => undefined,
      now: timeGenerator(),
      generateId: idGenerator(),
    },
  )

  if (!observedContext) throw new Error("Expected tool execution context")
  expect(observedContext.sessionId).toBe("session-context")
  expect(observedContext.runId).toBe(RUN_ID)
  expect(observedContext.toolCallId).toBe("call-context")
  expect(observedContext.modelProfile).toEqual({
    providerId: "openai",
    modelId: "gpt-5.6-sol",
    contextWindowTokens: 128_000,
  })
  expect(observedContext.providerAccountId).toBe("account-context")
  if (!observedContext.messages) throw new Error("Expected conversation context")
  expect(observedContext.messages.map((message) => message.role)).toEqual([
    "user",
    "user",
    "assistant",
  ])
  expect(observedContext.messages[1]).toMatchObject({
    role: "user",
    content: "Current question",
  })
  expect(observedContext.messages[2]).toMatchObject({
    role: "assistant",
    content: [{
      type: "toolCall",
      toolCallId: "call-context",
      toolName: "inspect_context",
    }],
  })
})

test("normalizes legacy string tool results to completed", async () => {
  const { toolResult } = await executeSingleTool(async () => "legacy result")

  expect(toolResult).toMatchObject({
    content: "legacy result",
    isError: false,
    outcome: "completed",
  })
  expect("summary" in toolResult).toBe(false)
})

test("accepts every structured tool outcome", async () => {
  const cases = [
    {
      value: { content: "applied", outcome: "completed", summary: "Applied" },
      isError: false,
    },
    {
      value: { content: "declined", outcome: "rejected", summary: "Declined" },
      isError: false,
    },
    {
      value: { content: "copied", outcome: "manual", summary: "Run manually" },
      isError: false,
    },
    {
      value: { content: "exit 7", outcome: "failed", summary: "Command failed" },
      isError: true,
    },
    {
      value: {
        content: "committed",
        outcome: "committed-after-abort",
        summary: "Committed during cancellation",
      },
      isError: true,
    },
    {
      value: {
        content: "result not recorded",
        outcome: "effects-unknown",
        summary: "Inspect current state",
      },
      isError: true,
    },
  ] as const

  for (const testCase of cases) {
    const { toolResult } = await executeSingleTool(async () => testCase.value)
    expect(toolResult).toMatchObject({
      ...testCase.value,
      isError: testCase.isError,
    })
  }
})

test("turns invalid structured tool results into errors", async () => {
  const cases = [
    {
      value: { content: 42 },
      error: 'Tool "test_tool" result content must be a string',
    },
    {
      value: { content: "result", outcome: "unknown" },
      error: 'Tool "test_tool" result outcome is invalid',
    },
    {
      value: { content: "result", summary: 42 },
      error: 'Tool "test_tool" result summary must be a string',
    },
  ]

  for (const testCase of cases) {
    const execute = (async () => testCase.value) as unknown as IAgentTool["execute"]
    const { toolResult } = await executeSingleTool(execute)
    expect(toolResult).toMatchObject({
      content: testCase.error,
      isError: true,
    })
    expect("outcome" in toolResult).toBe(false)
    expect("summary" in toolResult).toBe(false)
  }
})

test("preserves a committed error when cancellation races with a tool", async () => {
  const controller = new AbortController()
  const { result, toolResult } = await executeSingleTool(async () => {
    controller.abort("Stopped by test")
    throw Object.assign(new Error("Command completed after cancellation"), {
      committed: true,
    })
  }, controller.signal)

  expect(result.reason).toBe("aborted")
  expect(toolResult).toMatchObject({
    content: "Command completed after cancellation",
    isError: true,
    outcome: "committed-after-abort",
    summary: expect.stringMatching(/workspace changes were committed despite cancellation/i),
  })
})

test("preserves an error that reports unknown side effects", async () => {
  const { toolResult } = await executeSingleTool(async () => {
    throw Object.assign(new Error("Rollback was incomplete"), {
      sideEffectsUnknown: true,
    })
  })

  expect(toolResult).toMatchObject({
    content: "Rollback was incomplete",
    isError: true,
    outcome: "effects-unknown",
    summary: expect.stringMatching(/inspect current state before retrying/i),
  })
})

test("preserves a structured unknown-effects result during cancellation", async () => {
  const controller = new AbortController()
  const { result, toolResult } = await executeSingleTool(async () => {
    controller.abort("Stopped by test")
    return {
      content: "Execution may have changed files",
      outcome: "effects-unknown",
      summary: "Inspect current state",
    }
  }, controller.signal)

  expect(result.reason).toBe("aborted")
  expect(toolResult).toMatchObject({
    content: "Execution may have changed files",
    isError: true,
    outcome: "effects-unknown",
    summary: "Inspect current state",
  })
})

test("preserves an authoritative completed result during later cancellation", async () => {
  const controller = new AbortController()
  const { result, toolResult } = await executeSingleTool(async () => {
    controller.abort("Stopped after completion")
    return {
      content: "Command completed",
      outcome: "completed",
      summary: "Exit code 0",
    }
  }, controller.signal)

  expect(result.reason).toBe("aborted")
  expect(toolResult).toMatchObject({
    content: "Command completed",
    isError: false,
    outcome: "completed",
    summary: "Exit code 0",
  })
})

test("keeps ordinary aborted tool errors generic", async () => {
  const controller = new AbortController()
  const { toolResult } = await executeSingleTool(async () => {
    controller.abort("Stopped by test")
    throw new Error("Ordinary tool failure")
  }, controller.signal)

  expect(toolResult).toMatchObject({
    content: "Stopped by test",
    isError: true,
  })
  expect("outcome" in toolResult).toBe(false)
  expect("summary" in toolResult).toBe(false)
})

test("always gives tools an approval bridge with exact execution context", async () => {
  const model = new ScriptedModel((iteration) => iteration === 0
    ? [
        {
          type: "tool-call",
          toolCallId: "call-command",
          toolName: "run_command",
          input: {},
        },
        { type: "finish", reason: "tool-calls" },
      ]
    : [{ type: "finish", reason: "stop" }])
  const decisions: string[] = []
  const tool: IAgentTool = {
    name: "run_command",
    approvalKind: "command",
    description: "Run a command",
    inputSchema: { type: "object", additionalProperties: false },
    async execute(_input, context) {
      if (!context.requestApproval) throw new Error("Missing approval bridge")
      decisions.push(await context.requestApproval({
        kind: "command",
        title: "List files",
        explanation: "Inspect the workspace",
        command: "ls",
        cwd: "/workspace",
        purpose: "Find project files",
        expectedOutcome: "A file list",
        sideEffects: "None",
        timeoutSeconds: 30,
      }))
      return "complete"
    },
  }
  const approvalContexts: Array<{
    sessionId: string
    runId: string
    toolCallId: string
    aborted: boolean
  }> = []

  const result = await runAgentLoop(
    userMessage("List the workspace files"),
    {
      systemPrompt: "System",
      messages: [],
      tools: [tool],
    },
    {
      sessionId: "session-1",
      runId: RUN_ID,
      model,
      reasoningEffort: "medium",
      signal: new AbortController().signal,
      emit: () => undefined,
      requestApproval: async (draft, context) => {
        expect(draft).toMatchObject({
          kind: "command",
          command: "ls",
          cwd: "/workspace",
        })
        approvalContexts.push({
          sessionId: context.sessionId,
          runId: context.runId,
          toolCallId: context.toolCallId,
          aborted: context.signal.aborted,
        })
        return "copy"
      },
      now: timeGenerator(),
      generateId: idGenerator(),
    },
  )

  expect(decisions).toEqual(["copy"])
  expect(approvalContexts).toEqual([{
    sessionId: "session-1",
    runId: RUN_ID,
    toolCallId: "call-command",
    aborted: false,
  }])
  expect(result.messages.find((message) => message.role === "toolResult"))
    .toMatchObject({ content: "complete", isError: false })
})

test("allows one approval request per tool call", async () => {
  const model = new ScriptedModel((iteration) => iteration === 0
    ? [
        {
          type: "tool-call",
          toolCallId: "call-command",
          toolName: "run_command",
          input: {},
        },
        { type: "finish", reason: "tool-calls" },
      ]
    : [{ type: "finish", reason: "stop" }])
  let approvals = 0
  const draft = commandApprovalDraft()
  const tool: IAgentTool = {
    name: "run_command",
    approvalKind: "command",
    description: "Run a command",
    inputSchema: { type: "object", additionalProperties: false },
    async execute(_input, context) {
      if (!context.requestApproval) throw new Error("Missing approval bridge")
      await context.requestApproval(draft)
      await context.requestApproval(draft)
      return "unexpected"
    },
  }

  const result = await runAgentLoop(
    userMessage("Run the command"),
    {
      systemPrompt: "System",
      messages: [],
      tools: [tool],
    },
    {
      sessionId: "session-1",
      runId: RUN_ID,
      model,
      reasoningEffort: "medium",
      signal: new AbortController().signal,
      emit: () => undefined,
      requestApproval: async () => {
        approvals += 1
        return "reject"
      },
      now: timeGenerator(),
      generateId: idGenerator(),
    },
  )

  expect(approvals).toBe(1)
  expect(result.messages.find((message) => message.role === "toolResult"))
    .toMatchObject({
      isError: true,
      content: expect.stringContaining("already requested approval for this call"),
    })
})

test("exposes every registered tool for every prompt", async () => {
  const readTool: IAgentTool = {
    name: "read",
    description: "Read",
    inputSchema: { type: "object" },
    execute: async () => "read",
  }
  const editTool: IAgentTool = {
    name: "edit_file",
    description: "Edit",
    inputSchema: { type: "object" },
    execute: async () => "edit",
  }
  const commandTool: IAgentTool = {
    name: "bash",
    approvalKind: "command",
    description: "Command",
    inputSchema: { type: "object" },
    execute: async () => "command",
  }
  const prompts = [
    "Explain this",
    "Pokaż pełny kod parsera",
    "Czy możesz zająć się implementacją parsera?",
    "Sprawdź testy",
  ] as const

  for (const prompt of prompts) {
    const model = new ScriptedModel([{ type: "finish", reason: "stop" }])
    await runAgentLoop(
      userMessage(prompt),
      {
        systemPrompt: "System",
        messages: [],
        tools: [readTool, editTool, commandTool],
      },
      {
        sessionId: "session-1",
        runId: RUN_ID,
        model,
        reasoningEffort: "medium",
        signal: new AbortController().signal,
        emit: () => undefined,
      },
    )

    expect(model.requests[0]?.tools.map((tool) => tool.name)).toEqual([
      "read",
      "edit_file",
      "bash",
    ])
  }
})

test("exposes action tools independently of message history", async () => {
  const model = new ScriptedModel([{ type: "finish", reason: "stop" }])
  const editTool: IAgentTool = {
    name: "edit_file",
    description: "Edit",
    inputSchema: { type: "object" },
    execute: async () => "edit",
  }
  const previousRequest = {
    ...userMessage("Please handle the old task"),
    id: "previous-user-message",
    runId: "previous-run",
  }

  await runAgentLoop(
    userMessage("Continue"),
    {
      systemPrompt: "System",
      messages: [previousRequest],
      tools: [editTool],
    },
    {
      sessionId: "session-1",
      runId: RUN_ID,
      model,
      reasoningEffort: "medium",
      signal: new AbortController().signal,
      emit: () => undefined,
    },
  )

  expect(model.requests[0]?.tools.map((tool) => tool.name)).toEqual([
    "edit_file",
  ])
})

test("keeps all tools available across read and approval continuations", async () => {
  const model = new ScriptedModel((iteration) => {
    if (iteration === 0) {
      return [
        {
          type: "tool-call",
          toolCallId: "read-first",
          toolName: "read",
          input: {},
        },
        { type: "finish", reason: "tool-calls" },
      ]
    }
    if (iteration === 1) {
      return [
        {
          type: "tool-call",
          toolCallId: "command-after-read",
          toolName: "bash",
          input: {},
        },
        { type: "finish", reason: "tool-calls" },
      ]
    }
    return [{ type: "finish", reason: "stop" }]
  })
  let approvals = 0
  const readTool: IAgentTool = {
    name: "read",
    description: "Read",
    inputSchema: { type: "object", additionalProperties: false },
    execute: async () => "contents",
  }
  const commandTool: IAgentTool = {
    name: "bash",
    approvalKind: "command",
    description: "Run a command",
    inputSchema: { type: "object", additionalProperties: false },
    async execute(_input, context) {
      if (!context.requestApproval) throw new Error("Missing approval bridge")
      return await context.requestApproval(commandApprovalDraft())
    },
  }

  await runAgentLoop(
    userMessage("Implement the parser change"),
    {
      systemPrompt: "System",
      messages: [],
      tools: [readTool, commandTool],
    },
    {
      sessionId: "session-1",
      runId: RUN_ID,
      model,
      reasoningEffort: "medium",
      signal: new AbortController().signal,
      emit: () => undefined,
      requestApproval: async () => {
        approvals += 1
        return "reject"
      },
      now: timeGenerator(),
      generateId: idGenerator(),
    },
  )

  expect(approvals).toBe(1)
  expect(model.requests[0]?.tools.map((tool) => tool.name)).toEqual([
    "read",
    "bash",
  ])
  expect(model.requests[1]?.tools.map((tool) => tool.name)).toEqual([
    "read",
    "bash",
  ])
  expect(model.requests[2]?.tools.map((tool) => tool.name)).toEqual([
    "read",
    "bash",
  ])
})

test("lets each action call request its own approval", async () => {
  const model = new ScriptedModel((iteration) => iteration === 0
    ? [
        {
          type: "tool-call",
          toolCallId: "first-command",
          toolName: "bash",
          input: {},
        },
        {
          type: "tool-call",
          toolCallId: "second-command",
          toolName: "bash",
          input: {},
        },
        { type: "finish", reason: "tool-calls" },
      ]
    : [{ type: "finish", reason: "stop" }])
  let executions = 0
  let approvals = 0
  const tool: IAgentTool = {
    name: "bash",
    approvalKind: "command",
    description: "Run a command",
    inputSchema: { type: "object", additionalProperties: false },
    async execute(_input, context) {
      executions += 1
      if (!context.requestApproval) throw new Error("Missing approval bridge")
      return await context.requestApproval(commandApprovalDraft())
    },
  }

  const result = await runAgentLoop(
    userMessage("Run both commands"),
    {
      systemPrompt: "System",
      messages: [],
      tools: [tool],
    },
    {
      sessionId: "session-1",
      runId: RUN_ID,
      model,
      reasoningEffort: "medium",
      signal: new AbortController().signal,
      emit: () => undefined,
      requestApproval: async () => {
        approvals += 1
        return "reject"
      },
      now: timeGenerator(),
      generateId: idGenerator(),
    },
  )

  expect(executions).toBe(2)
  expect(approvals).toBe(2)
  expect(model.requests[0]?.tools.map((entry) => entry.name)).toEqual([
    "bash",
  ])
  expect(model.requests[1]?.tools.map((entry) => entry.name)).toEqual([
    "bash",
  ])
  expect(result.messages.filter((message) => message.role === "toolResult"))
    .toHaveLength(2)
  expect(result.messages.filter((message) => message.role === "toolResult")
    .every((message) => !message.isError)).toBe(true)
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
  const events: TAgentEvent[] = []

  const result = await runAgentLoop(
    userMessage("Read both files"),
    {
      systemPrompt: "System",
      messages: [],
      tools: [tool],
    },
    {
      sessionId: "session-1",
      runId: RUN_ID,
      model,
      reasoningEffort: "medium",
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
      inputQueue: testInputQueue({
        hasSteering: () => steering.length > 0,
        takeSteering: () => steering.shift(),
      }),
      now: timeGenerator(),
      generateId: idGenerator(),
    },
  )

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

  const result = await runAgentLoop(
    userMessage("Read the file"),
    {
      systemPrompt: "System",
      messages: [],
      tools: [tool],
    },
    {
      sessionId: "session-1",
      runId: RUN_ID,
      model,
      reasoningEffort: "medium",
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
      inputQueue: testInputQueue({
        hasSteering: () => steering.length > 0,
        takeSteering: () => steering.shift(),
        hasFollowUp: () => followUps.length > 0,
        takeFollowUp: () => followUps.shift(),
      }),
      now: timeGenerator(),
      generateId: idGenerator(),
    },
  )

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

  await runAgentLoop(
    userMessage("Run"),
    {
      systemPrompt: "System",
      messages: [],
      tools: [],
    },
    {
      sessionId: "session-1",
      runId: RUN_ID,
      model,
      reasoningEffort: "medium",
      signal: new AbortController().signal,
      emit: () => undefined,
      now: timeGenerator(),
      generateId: idGenerator(),
    },
  )

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

  const result = await runAgentLoop(
    userMessage("Question"),
    {
      systemPrompt: "System",
      messages: [],
      tools: [],
    },
    {
      sessionId: "session-1",
      runId: RUN_ID,
      model,
      reasoningEffort: "medium",
      signal: controller.signal,
      emit: () => undefined,
      now: timeGenerator(),
      generateId: idGenerator(),
    },
  )

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

test("stops a tool continuation when aborted during turn_end", async () => {
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

  const result = await runAgentLoop(
    userMessage("Read"),
    {
      systemPrompt: "System",
      messages: [],
      tools: [tool],
    },
    {
      sessionId: "session-1",
      runId: RUN_ID,
      model,
      reasoningEffort: "medium",
      signal: controller.signal,
      emit: (event) => {
        if (event.type === "turn_end") controller.abort("Stopped during turn_end")
      },
      now: timeGenerator(),
      generateId: idGenerator(),
    },
  )

  expect(result.reason).toBe("aborted")
})

test("gives abort precedence over a provider error during turn_end", async () => {
  const controller = new AbortController()
  const model = new ScriptedModel([{
    type: "error",
    error: new Error("Provider failed"),
  }])

  const result = await runAgentLoop(
    userMessage("Question"),
    {
      systemPrompt: "System",
      messages: [],
      tools: [],
    },
    {
      sessionId: "session-1",
      runId: RUN_ID,
      model,
      reasoningEffort: "medium",
      signal: controller.signal,
      emit: (event) => {
        if (event.type === "turn_end") controller.abort("Stopped during turn_end")
      },
      now: timeGenerator(),
      generateId: idGenerator(),
    },
  )

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
  const events: TAgentEvent[] = []

  await expect(runAgentLoop(
    userMessage("Question"),
    {
      systemPrompt: "System",
      messages: [],
      tools: [duplicate, { ...duplicate }],
    },
    {
      sessionId: "session-1",
      runId: RUN_ID,
      model,
      reasoningEffort: "medium",
      signal: new AbortController().signal,
      emit: (event) => {
        events.push(event)
      },
    },
  )).rejects.toThrow("Duplicate tool: read_file")

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

  const result = await runAgentLoop(
    userMessage("Read"),
    {
      systemPrompt: "System",
      messages: [],
      tools: [tool],
    },
    {
      sessionId: "session-1",
      runId: RUN_ID,
      model,
      reasoningEffort: "medium",
      signal: new AbortController().signal,
      emit: () => {},
      now: timeGenerator(),
      generateId: idGenerator(),
    },
  )

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

test("prepares arguments before normalizing optional nulls and converting values", async () => {
  const model = new ScriptedModel((iteration) => iteration === 0
    ? [
        {
          type: "tool-call",
          toolCallId: "converted-call",
          toolName: "converted",
          input: {
            count: "2",
            label: null,
            nested: { enabled: null },
          },
        },
        { type: "finish", reason: "tool-calls" },
      ]
    : [{ type: "finish", reason: "stop" }])
  let receivedInput: Record<string, unknown> | undefined
  const tool: IAgentTool = {
    name: "converted",
    description: "Convert arguments",
    inputSchema: Type.Object({
      count: Type.Number(),
      label: Type.Optional(Type.String()),
      nested: Type.Object({ enabled: Type.Optional(Type.Boolean()) }),
    }),
    prepareArguments: (input) => {
      const args = input as Record<string, unknown>
      return args.label === null ? { ...args, label: "prepared" } : args
    },
    execute: async (input) => {
      receivedInput = input
      return "converted"
    },
  }

  await runAgentLoop(
    userMessage("Convert"),
    { systemPrompt: "System", messages: [], tools: [tool] },
    {
      sessionId: "session-1",
      runId: RUN_ID,
      model,
      reasoningEffort: "medium",
      signal: new AbortController().signal,
      emit: () => {},
      now: timeGenerator(),
      generateId: idGenerator(),
    },
  )

  expect(receivedInput).toEqual({ count: 2, label: "prepared", nested: {} })
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
  const events: TAgentEvent[] = []

  await runAgentLoop(
    userMessage("Scan"),
    {
      systemPrompt: "System",
      messages: [],
      tools: [tool],
    },
    {
      sessionId: "session-1",
      runId: RUN_ID,
      model,
      reasoningEffort: "medium",
      signal: new AbortController().signal,
      emit: async (event) => {
        await Promise.resolve()
        events.push(structuredClone(event))
      },
      now: timeGenerator(),
      generateId: idGenerator(),
    },
  )
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

test("retains complete custom tool output before bounded persistence and continuation", async () => {
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
    execute: async () => ({
      content: "x".repeat(100_001),
      outcome: "manual",
      summary: "y".repeat(100_001),
    }),
  }

  const store = new EphemeralToolOutputStore()
  const result = await runAgentLoop(
    userMessage("Run"),
    {
      systemPrompt: "System",
      messages: [],
      tools: [tool],
    },
    {
      sessionId: "session-1",
      runId: RUN_ID,
      model,
      reasoningEffort: "medium",
      signal: new AbortController().signal,
      emit: () => {},
      now: timeGenerator(),
      generateId: idGenerator(),
      toolOutputStore: store,
    },
  )

  const persisted = result.messages.find((message) => message.role === "toolResult")
  const continued = model.requests[1]?.messages.find(
    (message) => message.role === "toolResult",
  )
  if (persisted?.role !== "toolResult") throw new Error("Expected tool result")
  if (continued?.role !== "toolResult") throw new Error("Expected continued result")
  expect(persisted).toEqual(continued)
  expect(persisted.outcome).toBe("manual")
  expect(persisted.content).toContain("Complete tool result stored as outputId=")
  expect(persisted.content).toEndWith("... output preview ended")
  expect(Buffer.byteLength(persisted.content, "utf8")).toBeLessThanOrEqual(
    100_000,
  )
  expect(persisted.summary).toContain("Complete summary stored as outputId=")
  expect(Buffer.byteLength(persisted.summary ?? "", "utf8")).toBeLessThanOrEqual(
    100_000,
  )
  const outputId = /outputId="([^"]+)"/.exec(persisted.content)?.[1]
  expect(outputId).toBeString()
  expect((await store.readPage({
    sessionId: "session-1",
    outputId: outputId!,
    part: "content",
    encoding: "text",
    offset: 0,
    maxBytes: 200_000,
    maxLines: 2_000,
  })).content).toBe("x".repeat(100_001))
  expect((await store.readPage({
    sessionId: "session-1",
    outputId: outputId!,
    part: "summary",
    encoding: "text",
    offset: 0,
    maxBytes: 200_000,
    maxLines: 2_000,
  })).content).toBe("y".repeat(100_001))
  await store.dispose()
})

test("returns a durable failure when oversized manual output cannot be stored", async () => {
  const model = new ScriptedModel((iteration) => iteration === 0
    ? [
        {
          type: "tool-call",
          toolCallId: "large-manual-call",
          toolName: "large-manual",
          input: {},
        },
        { type: "finish", reason: "tool-calls" },
      ]
    : [{ type: "finish", reason: "stop" }])
  const tool: IAgentTool = {
    name: "large-manual",
    description: "Large manual output",
    inputSchema: { type: "object", additionalProperties: false },
    execute: async () => ({
      content: "x".repeat(100_001),
      outcome: "manual",
    }),
  }

  const result = await runAgentLoop(
    userMessage("Run"),
    { systemPrompt: "System", messages: [], tools: [tool] },
    {
      sessionId: "session-1",
      runId: RUN_ID,
      model,
      reasoningEffort: "medium",
      signal: new AbortController().signal,
      emit: () => {},
      now: timeGenerator(),
      generateId: idGenerator(),
    },
  )

  expect(result.messages.find((message) => message.role === "toolResult"))
    .toMatchObject({
      role: "toolResult",
      isError: true,
      outcome: "failed",
      summary: "Complete tool output unavailable",
    })
})

test("bounds storage failure details and marks completed side effects unknown", async () => {
  const model = new ScriptedModel((iteration) => iteration === 0
    ? [
        {
          type: "tool-call",
          toolCallId: "failed-store-call",
          toolName: "failed-store",
          input: {},
        },
        { type: "finish", reason: "tool-calls" },
      ]
    : [{ type: "finish", reason: "stop" }])
  const tool: IAgentTool = {
    name: "failed-store",
    description: "Fail output storage",
    inputSchema: { type: "object", additionalProperties: false },
    execute: async () => "x".repeat(100_001),
  }
  const store: IToolOutputStore = {
    store: async () => {
      throw new Error("storage failure ".repeat(20_000))
    },
    createWriter: async () => {
      throw new Error("unused")
    },
    readPage: async () => {
      throw new Error("unused")
    },
    dispose: async () => {},
  }

  const result = await runAgentLoop(
    userMessage("Run"),
    { systemPrompt: "System", messages: [], tools: [tool] },
    {
      sessionId: "session-1",
      runId: RUN_ID,
      model,
      reasoningEffort: "medium",
      signal: new AbortController().signal,
      emit: () => {},
      now: timeGenerator(),
      generateId: idGenerator(),
      toolOutputStore: store,
    },
  )

  const toolResult = result.messages.find((message) => message.role === "toolResult")
  expect(toolResult).toMatchObject({
    role: "toolResult",
    isError: true,
    outcome: "effects-unknown",
    summary: "Complete tool output unavailable",
  })
  if (toolResult?.role !== "toolResult") throw new Error("Expected tool result")
  expect(toolResult.content).toStartWith("The complete result is unavailable")
  expect(Buffer.byteLength(toolResult.content, "utf8")).toBeLessThanOrEqual(100_000)
})

test("keeps output from tools that declare their own truncation", async () => {
  const content = "x".repeat(100_001)
  const model = new ScriptedModel((iteration) => iteration === 0
    ? [
        {
          type: "tool-call",
          toolCallId: "self-truncated-call",
          toolName: "self-truncated",
          input: {},
        },
        { type: "finish", reason: "tool-calls" },
      ]
    : [{ type: "finish", reason: "stop" }])
  const tool: IAgentTool = {
    name: "self-truncated",
    description: "Self-truncated output",
    inputSchema: { type: "object", additionalProperties: false },
    selfTruncatesOutput: true,
    execute: async () => content,
  }

  const result = await runAgentLoop(
    userMessage("Run"),
    { systemPrompt: "System", messages: [], tools: [tool] },
    {
      sessionId: "session-1",
      runId: RUN_ID,
      model,
      reasoningEffort: "medium",
      signal: new AbortController().signal,
      emit: () => {},
      now: timeGenerator(),
      generateId: idGenerator(),
    },
  )

  expect(result.messages.find((message) => message.role === "toolResult"))
    .toMatchObject({ content, isError: false, outcome: "completed" })
})

async function executeSingleTool(
  execute: IAgentTool["execute"],
  signal: AbortSignal = new AbortController().signal,
) {
  const model = new ScriptedModel((iteration) => iteration === 0
    ? [
        {
          type: "tool-call",
          toolCallId: "test-call",
          toolName: "test_tool",
          input: {},
        },
        { type: "finish", reason: "tool-calls" },
      ]
    : [{ type: "finish", reason: "stop" }])
  const result = await runAgentLoop(
    userMessage("Run tool"),
    {
      systemPrompt: "System",
      messages: [],
      tools: [{
        name: "test_tool",
        description: "Test tool",
        inputSchema: { type: "object", additionalProperties: false },
        execute,
      }],
    },
    {
      sessionId: "session-1",
      runId: RUN_ID,
      model,
      reasoningEffort: "medium",
      signal,
      emit: () => undefined,
      now: timeGenerator(),
      generateId: idGenerator(),
    },
  )
  const toolResult = result.messages.find((message) => message.role === "toolResult")
  if (toolResult?.role !== "toolResult") throw new Error("Expected tool result")
  return { result, toolResult }
}

function testInputQueue(
  overrides: Partial<IAgentInputQueue>,
): IAgentInputQueue {
  return {
    hasSteering: () => false,
    takeSteering: () => undefined,
    hasFollowUp: () => false,
    takeFollowUp: () => undefined,
    restore: () => undefined,
    close: () => undefined,
    ...overrides,
  }
}

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

function commandApprovalDraft() {
  return {
    kind: "command" as const,
    title: "Run focused tests",
    explanation: "Execute the requested verification command",
    command: "bun test test/agent-loop.test.ts",
    cwd: "/workspace",
    purpose: "Verify agent behavior",
    expectedOutcome: "The focused tests pass",
    sideEffects: "May write temporary test caches",
    timeoutSeconds: 30,
  }
}
