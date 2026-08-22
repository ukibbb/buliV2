import { expect, test } from "bun:test"
import { realpathSync } from "node:fs"

import type {
  IAgentModelEvent,
  IAgentToolDescriptor,
  TAgentMessage,
} from "@/agent"
import { systemPrompt } from "@/agent/system-prompt"
import type {
  IAuthStore,
  IOAuthCredential,
  TAuthCredential,
} from "@/authentication/credentials"
import { OpenAiAuth } from "@/providers/openai/auth/openai-auth"
import { OpenAiAgentModel } from "@/providers/openai/model/openai-agent-model"
import { OPENAI_CODEX_RESPONSES_URL } from "@/providers/openai/constants"
import { AgentSession } from "@/sessions/agent-session"
import { InMemorySessionManager } from "@/sessions/in-memory-session-manager"
import { createWorkspaceTools } from "@/tools"

const WORKSPACE_ROOT = realpathSync(process.cwd())

test("runs an OAuth tool chain through Agent-owned iterations", async () => {
  const capturedRequests: Request[] = []
  const captureFetch = fetchImplementation(async (...args) => {
    capturedRequests.push(new Request(...args))
    if (capturedRequests.length === 1) {
      return toolCallResponse("glob", { pattern: "package.json" })
    }
    if (capturedRequests.length === 2) {
      return toolCallResponse("grep", { pattern: "packageManager" })
    }
    if (capturedRequests.length === 3) {
      return toolCallResponse("read", { path: "package.json" })
    }
    return streamResponse()
  })
  const auth = new OpenAiAuth({
    store: authStore({
      type: "oauth",
      access: "test-access-token",
      refresh: "test-refresh-token",
      expires: 1_000_000,
      accountId: "test-account-id",
    }),
    fetch: captureFetch,
    now: () => 100,
  })
  const model = new OpenAiAgentModel({
    auth,
    modelId: "gpt-5.6-sol",
  })
  const messages: TAgentMessage[] = [
    {
      id: "previous-user",
      sessionId: "session-1",
      runId: "previous-run",
      role: "user",
      source: "prompt",
      content: "First\n\nSecond",
      createdAt: 1,
    },
    {
      id: "previous-assistant",
      sessionId: "session-1",
      runId: "previous-run",
      role: "assistant",
      content: [
        { type: "text", text: "Answer" },
        { type: "reasoning", text: "Do not send this" },
      ],
      stopReason: "stop",
      createdAt: 2,
    },
  ]
  const manager = new InMemorySessionManager()
  manager.createSession(testSessionInfo())
  messages.forEach(manager.appendMessage)
  const session = new AgentSession({
    agentId: "test-agent",
    sessionId: "session-1",
    manager,
    systemPrompt: systemPrompt(WORKSPACE_ROOT, createWorkspaceTools(WORKSPACE_ROOT)),
    resolveRunConfiguration: () => ({
      model,
      reasoningEffort: "medium",
    }),
    tools: createWorkspaceTools(WORKSPACE_ROOT),
  })

  await session.prompt("Continue").settled

  const [firstRequest, secondRequest, thirdRequest, fourthRequest] = capturedRequests
  if (!firstRequest || !secondRequest || !thirdRequest || !fourthRequest) {
    throw new Error("Expected the OpenAI SDK to issue four requests")
  }

  expect(capturedRequests).toHaveLength(4)
  expect(firstRequest.url).toBe(OPENAI_CODEX_RESPONSES_URL)
  expect(firstRequest.headers.get("authorization")).toBe("Bearer test-access-token")
  expect(firstRequest.headers.get("chatgpt-account-id")).toBe("test-account-id")
  expect(firstRequest.headers.get("originator")).toBe("buli")
  expect(firstRequest.headers.get("openai-beta")).toBe("responses=experimental")

  const body = (await firstRequest.json()) as Record<string, unknown>
  expect(body.model).toBe("gpt-5.6-sol")
  expect(body.store).toBe(false)
  expect(body.stream).toBe(true)
  expect(body.reasoning).toMatchObject({ effort: "medium" })
  expect(body.instructions).toContain("pair programming")
  expect(body.instructions).toContain(
    `Aktualny katalog roboczy i root workspace: ${WORKSPACE_ROOT}.`,
  )
  expect(body.tools).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: "function", name: "read" }),
    expect.objectContaining({ type: "function", name: "glob" }),
    expect.objectContaining({ type: "function", name: "grep" }),
    expect.objectContaining({ type: "function", name: "request_patch_handoff" }),
    expect.objectContaining({ type: "function", name: "bash" }),
  ]))
  expect(JSON.stringify(body.tools)).not.toContain("write_file")
  expect(body.tools).not.toEqual(expect.arrayContaining([
    expect.objectContaining({ type: "function", name: "apply_patch" }),
  ]))

  expect(body.input).toEqual([
    {
      role: "user",
      content: [{ type: "input_text", text: "First\n\nSecond" }],
    },
    {
      role: "assistant",
      content: [{ type: "output_text", text: "Answer" }],
    },
    {
      role: "user",
      content: [{ type: "input_text", text: "Continue" }],
    },
  ])
  expect(JSON.stringify(body.input)).not.toContain("Do not send this")

  const globContinuation = (await secondRequest.json()) as Record<string, unknown>
  expect(globContinuation.input).toEqual(expect.arrayContaining([
    {
      type: "function_call",
      call_id: "call-glob",
      name: "glob",
      arguments: JSON.stringify({ pattern: "package.json" }),
    },
    {
      type: "function_call_output",
      call_id: "call-glob",
      output: "package.json",
    },
  ]))

  const grepContinuation = (await thirdRequest.json()) as Record<string, unknown>
  expect(JSON.stringify(grepContinuation.input)).toContain("bun@1.3.12")

  const readContinuation = (await fourthRequest.json()) as Record<string, unknown>
  expect(JSON.stringify(readContinuation.input)).toContain("scripts")

  const stored = manager.getMessages("session-1")
  const toolCalls = stored.flatMap((message) => message.role === "assistant"
    ? message.content.filter((content) => content.type === "toolCall")
    : [])
  const toolResults = stored.filter((message) => message.role === "toolResult")

  expect(toolCalls).toEqual([
    {
      type: "toolCall",
      toolCallId: "call-glob",
      toolName: "glob",
      input: { pattern: "package.json" },
    },
    {
      type: "toolCall",
      toolCallId: "call-grep",
      toolName: "grep",
      input: { pattern: "packageManager" },
    },
    {
      type: "toolCall",
      toolCallId: "call-read",
      toolName: "read",
      input: { path: "package.json" },
    },
  ])
  expect(toolResults).toEqual([
    expect.objectContaining({
      role: "toolResult",
      toolCallId: "call-glob",
      toolName: "glob",
      content: "package.json",
      isError: false,
    }),
    expect.objectContaining({
      role: "toolResult",
      toolCallId: "call-grep",
      toolName: "grep",
      content: expect.stringContaining("bun@1.3.12"),
      isError: false,
    }),
    expect.objectContaining({
      role: "toolResult",
      toolCallId: "call-read",
      toolName: "read",
      content: expect.stringContaining('"scripts"'),
      isError: false,
    }),
  ])
  const finalMessage = stored.at(-1)
  expect(finalMessage).toMatchObject({
    role: "assistant",
    stopReason: "stop",
  })
  if (finalMessage?.role !== "assistant") {
    throw new Error("Expected a final assistant message")
  }
  expect(finalMessage.content).toContainEqual({ type: "text", text: "Hello" })
})

test("replays a local tool failure into the next OAuth iteration", async () => {
  const capturedRequests: Request[] = []
  const missingPath = "__buli_missing_tool_file__.txt"
  const captureFetch = fetchImplementation(async (...args) => {
    capturedRequests.push(new Request(...args))
    return capturedRequests.length === 1
      ? toolCallResponse("read", { path: missingPath })
      : streamResponse()
  })
  const auth = new OpenAiAuth({
    store: authStore({
      type: "oauth",
      access: "test-access-token",
      refresh: "test-refresh-token",
      expires: 1_000_000,
      accountId: "test-account-id",
    }),
    fetch: captureFetch,
    now: () => 100,
  })
  const manager = new InMemorySessionManager()
  manager.createSession(testSessionInfo())
  const session = new AgentSession({
    agentId: "test-agent",
    sessionId: "session-1",
    manager,
    systemPrompt: systemPrompt(WORKSPACE_ROOT, createWorkspaceTools(WORKSPACE_ROOT)),
    resolveRunConfiguration: () => ({
      model: new OpenAiAgentModel({
        auth,
      }),
      reasoningEffort: "medium",
    }),
    tools: createWorkspaceTools(WORKSPACE_ROOT),
  })

  await session.prompt("Read the missing file").settled

  expect(capturedRequests).toHaveLength(2)
  const failedTool = manager
    .getMessages("session-1")
    .find((message) => message.role === "toolResult")

  if (failedTool?.role !== "toolResult") {
    throw new Error("Expected a failed read tool")
  }

  expect(failedTool).toMatchObject({
    toolCallId: "call-read",
    toolName: "read",
    isError: true,
  })

  const continuation = capturedRequests[1]
  if (!continuation) throw new Error("Expected a continuation request")
  const body = (await continuation.json()) as Record<string, unknown>
  expect(body.input).toEqual(expect.arrayContaining([
    {
      type: "function_call",
      call_id: "call-read",
      name: "read",
      arguments: JSON.stringify({ path: missingPath }),
    },
    {
      type: "function_call_output",
      call_id: "call-read",
      output: failedTool.content,
    },
  ]))
  expect(manager.getMessages("session-1").at(-1)).toMatchObject({
    role: "assistant",
    stopReason: "stop",
  })
})

test("lowers direct assistant and text-only toolResult messages", async () => {
  const capturedRequests: Request[] = []
  const model = createModel(async (...args) => {
    capturedRequests.push(new Request(...args))
    return streamResponse()
  })

  const events = await collectEvents(model, [
    userMessage("Question"),
    {
      id: "assistant-message",
      sessionId: "session-1",
      runId: "run-1",
      role: "assistant",
      content: [
        { type: "text", text: "I will inspect it." },
        {
          type: "toolCall",
          toolCallId: "call-read",
          toolName: "read_file",
          input: { path: "README.md" },
        },
      ],
      stopReason: "tool-calls",
      createdAt: 2,
    },
    {
      id: "tool-result-message",
      sessionId: "session-1",
      runId: "run-1",
      role: "toolResult",
      toolCallId: "call-read",
      toolName: "read_file",
      content: "README contents",
      isError: false,
      createdAt: 3,
    },
  ], [toolDescriptor("read_file")])

  expect(events).toContainEqual({
    type: "finish",
    reason: "stop",
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  })
  expect(capturedRequests).toHaveLength(1)
  const request = capturedRequests[0]
  if (!request) throw new Error("Expected an OpenAI request")
  const body = (await request.json()) as Record<string, unknown>
  expect(body.input).toEqual([
    {
      role: "user",
      content: [{ type: "input_text", text: "Question" }],
    },
    {
      role: "assistant",
      content: [{ type: "output_text", text: "I will inspect it." }],
    },
    {
      type: "function_call",
      call_id: "call-read",
      name: "read_file",
      arguments: JSON.stringify({ path: "README.md" }),
    },
    {
      type: "function_call_output",
      call_id: "call-read",
      output: "README contents",
    },
  ])
})

test("projects structured tool outcomes as text-only provider results", async () => {
  const capturedRequests: Request[] = []
  const model = createModel(async (...args) => {
    capturedRequests.push(new Request(...args))
    return streamResponse()
  })
  const outcomes = [
    "completed",
    "rejected",
    "manual",
    "failed",
    "committed-after-abort",
    "effects-unknown",
  ] as const

  for (const [index, outcome] of outcomes.entries()) {
    const toolCallId = `call-${index}`
    await collectEvents(model, [
      userMessage("Question"),
      {
        id: `assistant-${index}`,
        sessionId: "session-1",
        runId: "run-1",
        role: "assistant",
        content: [{
          type: "toolCall",
          toolCallId,
          toolName: "test_tool",
          input: {},
        }],
        stopReason: "tool-calls",
        createdAt: 2,
      },
      {
        id: `result-${index}`,
        sessionId: "session-1",
        runId: "run-1",
        role: "toolResult",
        toolCallId,
        toolName: "test_tool",
        content: `provider-visible-${index}`,
        isError: outcome === "failed"
          || outcome === "committed-after-abort"
          || outcome === "effects-unknown",
        outcome,
        summary: `HOST_ONLY_SUMMARY_${index}`,
        createdAt: 3,
      },
    ], [toolDescriptor("test_tool")])
  }

  expect(capturedRequests).toHaveLength(outcomes.length)
  for (const [index, request] of capturedRequests.entries()) {
    const body = (await request.json()) as Record<string, unknown>
    expect(body.input).toEqual(expect.arrayContaining([{
      type: "function_call_output",
      call_id: `call-${index}`,
      output: `provider-visible-${index}`,
    }]))
    const input = JSON.stringify(body.input)
    expect(input).not.toContain("HOST_ONLY_SUMMARY")
    expect(input).not.toContain('"outcome"')
    expect(input).not.toContain('"summary"')
  }
})

test("sends projected context summaries and compaction output limits", async () => {
  let capturedRequest: Request | undefined
  const model = createModel(async (...args) => {
    capturedRequest = new Request(...args)
    return streamResponse()
  })
  const events: IAgentModelEvent[] = []

  for await (const event of model.stream({
    sessionId: "session-1",
    runId: "compaction-1",
    systemPrompt: "Summarize",
    contextSummary: "Earlier durable context",
    messages: [userMessage("New tail")],
    tools: [],
    reasoningEffort: "low",
    maxOutputTokens: 321,
    signal: new AbortController().signal,
  })) {
    events.push(event)
  }

  if (!capturedRequest) throw new Error("Expected one provider request")
  const body = (await capturedRequest.json()) as Record<string, unknown>
  expect(JSON.stringify(body)).toContain("Earlier durable context")
  expect(body.max_output_tokens).toBe(321)
  expect(events.at(-1)).toMatchObject({
    type: "finish",
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  })
})

test("emits every tool call from one provider response for the host loop", async () => {
  const model = createModel(async () => multiToolCallResponse([
    {
      toolCallId: "call-glob",
      toolName: "glob",
      input: { pattern: "*.ts" },
    },
    {
      toolCallId: "call-grep",
      toolName: "grep",
      input: { pattern: "toolCallId" },
    },
  ]))

  const events = await collectEvents(
    model,
    [userMessage("Inspect the workspace")],
    [toolDescriptor("glob"), toolDescriptor("grep")],
  )

  expect(events.filter((event) => event.type === "tool-call")).toEqual([
    {
      type: "tool-call",
      toolCallId: "call-glob",
      toolName: "glob",
      input: { pattern: "*.ts" },
    },
    {
      type: "tool-call",
      toolCallId: "call-grep",
      toolName: "grep",
      input: { pattern: "toolCallId" },
    },
  ])
  expect(events.at(-1)).toEqual({
    type: "finish",
    reason: "tool-calls",
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  })
})

test("forwards cancellation to the OpenAI request", async () => {
  const requestStarted = Promise.withResolvers<AbortSignal>()
  const stalledFetch = fetchImplementation(async (_input, init) => {
    const signal = init?.signal
    if (!signal) throw new Error("Expected an OpenAI request signal")
    requestStarted.resolve(signal)

    return new Promise<Response>((_resolve, reject) => {
      const abort = () => reject(new DOMException("Request aborted", "AbortError"))
      if (signal.aborted) return abort()
      signal.addEventListener("abort", abort, { once: true })
    })
  })
  const auth = new OpenAiAuth({
    store: authStore({
      type: "oauth",
      access: "test-access-token",
      refresh: "test-refresh-token",
      expires: 1_000_000,
      accountId: "test-account-id",
    }),
    fetch: stalledFetch,
    now: () => 100,
  })
  const model = new OpenAiAgentModel({
    auth,
  })
  const controller = new AbortController()
  const eventsPromise = (async () => {
    const events = []
    for await (const event of model.stream({
      sessionId: "session-1",
      runId: "run-1",
      systemPrompt: systemPrompt(WORKSPACE_ROOT, []),
      messages: [userMessage("Wait")],
      tools: [],
      reasoningEffort: "medium",
      signal: controller.signal,
    })) {
      events.push(event)
    }
    return events
  })()

  const providerSignal = await requestStarted.promise
  controller.abort("Stopped by test")
  const events = await eventsPromise

  expect(providerSignal.aborted).toBe(true)
  expect(events).toContainEqual({ type: "abort", reason: "Stopped by test" })
})

function authStore(credential: IOAuthCredential): IAuthStore {
  let current: TAuthCredential | undefined = credential
  return {
    async get(providerID) {
      return providerID === "openai" ? current : undefined
    },
    async set(providerID, next) {
      if (providerID === "openai") current = next
    },
    async remove(providerID) {
      if (providerID !== "openai" || !current) return false
      current = undefined
      return true
    },
    async modify(providerID, update) {
      if (providerID !== "openai") return undefined
      current = await update(current)
      return current
    },
    async beginOperation() {
      return 1
    },
    async commitOperation(providerID, _operation, next) {
      if (providerID !== "openai") return false
      current = next
      return true
    },
  }
}

function fetchImplementation(
  run: (...args: Parameters<typeof globalThis.fetch>) => Promise<Response>,
): typeof fetch {
  return Object.assign(run, { preconnect: globalThis.fetch.preconnect })
}

function streamResponse(): Response {
  return eventStream([
    {
      type: "response.created",
      response: {
        id: "response-1",
        created_at: 1,
        model: "gpt-5.6-sol",
        service_tier: null,
      },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", id: "answer" },
    },
    {
      type: "response.output_text.delta",
      item_id: "answer",
      delta: "Hello",
      logprobs: null,
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "message", id: "answer" },
    },
    {
      type: "response.completed",
      response: {
        incomplete_details: null,
        usage: {
          input_tokens: 1,
          input_tokens_details: null,
          output_tokens: 1,
          output_tokens_details: null,
        },
        service_tier: null,
      },
    },
  ])
}

function toolCallResponse(
  toolName: string,
  input: Record<string, unknown>,
): Response {
  return multiToolCallResponse([{ toolCallId: `call-${toolName}`, toolName, input }])
}

function multiToolCallResponse(
  calls: readonly {
    toolCallId: string
    toolName: string
    input: Record<string, unknown>
  }[],
): Response {
  const toolCallItems = calls.flatMap((call, outputIndex) => [
    {
      type: "response.output_item.added",
      output_index: outputIndex,
      item: {
        type: "function_call",
        id: `function-${call.toolCallId}`,
        call_id: call.toolCallId,
        name: call.toolName,
        arguments: "",
      },
    },
    {
      type: "response.output_item.done",
      output_index: outputIndex,
      item: {
        type: "function_call",
        id: `function-${call.toolCallId}`,
        call_id: call.toolCallId,
        name: call.toolName,
        arguments: JSON.stringify(call.input),
        status: "completed",
      },
    },
  ])

  return eventStream([
    {
      type: "response.created",
      response: {
        id: "response-tools",
        created_at: 1,
        model: "gpt-5.6-sol",
        service_tier: null,
      },
    },
    ...toolCallItems,
    {
      type: "response.completed",
      response: {
        incomplete_details: null,
        usage: {
          input_tokens: 1,
          input_tokens_details: null,
          output_tokens: 1,
          output_tokens_details: null,
        },
        service_tier: null,
      },
    },
  ])
}

function eventStream(chunks: readonly Record<string, unknown>[]): Response {
  const body = chunks
    .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
    .join("")

  return new Response(`${body}data: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
  })
}

function createModel(
  run: (...args: Parameters<typeof globalThis.fetch>) => Promise<Response>,
): OpenAiAgentModel {
  const auth = new OpenAiAuth({
    store: authStore({
      type: "oauth",
      access: "test-access-token",
      refresh: "test-refresh-token",
      expires: 1_000_000,
      accountId: "test-account-id",
    }),
    fetch: fetchImplementation(run),
    now: () => 100,
  })
  return new OpenAiAgentModel({ auth })
}

async function collectEvents(
  model: OpenAiAgentModel,
  messages: readonly TAgentMessage[],
  tools: readonly IAgentToolDescriptor[],
): Promise<IAgentModelEvent[]> {
  const events: IAgentModelEvent[] = []
  for await (const event of model.stream({
    sessionId: "session-1",
    runId: "run-1",
    systemPrompt: "System",
    messages,
    tools,
    reasoningEffort: "medium",
    signal: new AbortController().signal,
  })) {
    events.push(event)
  }
  return events
}

function userMessage(content: string): TAgentMessage {
  return {
    id: "user-message",
    sessionId: "session-1",
    runId: "run-1",
    role: "user",
    source: "prompt",
    content,
    createdAt: 1,
  }
}

function testSessionInfo() {
  return {
    id: "session-1",
    agentId: "test-agent",
    title: "Test session",
    createdAt: 1,
    updatedAt: 1,
  }
}

function toolDescriptor(name: string): IAgentToolDescriptor {
  return {
    name,
    description: `Run ${name}`,
    inputSchema: { type: "object" },
  }
}
