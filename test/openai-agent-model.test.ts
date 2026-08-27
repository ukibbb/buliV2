import { expect, test } from "bun:test"
import { realpathSync } from "node:fs"

import {
    isModelContextOverflowError,
    runAgentLoop,
    type AgentMessage,
    type AgentModelEvent,
    type AgentTool,
    type AgentToolDescriptor,
    type UserMessage,
} from "@/agent"
import { systemPrompt } from "@/agent/system-prompt"
import type {
  IAuthStore,
  IOAuthCredential,
  TAuthCredential,
} from "@/authentication/credentials"
import { OpenAiAuth } from "@/providers/openai/auth/openai-auth"
import {
  OpenAiAgentModel,
  type IOpenAiAgentModelOptions,
} from "@/providers/openai/model/openai-agent-model"
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
  const messages: AgentMessage[] = [
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
  expect(body.reasoning).toMatchObject({ effort: "medium", summary: "detailed" })
  expect(body.instructions).toContain("pair programming")
  expect(body.instructions).toContain(
    `Aktualny katalog roboczy i root workspace: ${WORKSPACE_ROOT}.`,
  )
  expect(body.tools).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: "function", name: "read" }),
    expect.objectContaining({ type: "function", name: "glob" }),
    expect.objectContaining({ type: "function", name: "grep" }),
    expect.objectContaining({ type: "function", name: "apply_patch" }),
    expect.objectContaining({ type: "function", name: "bash" }),
  ]))
  expect(JSON.stringify(body.tools)).not.toContain("write_file")

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

test("lowers user image attachments to OpenAI input_image parts", async () => {
  const capturedRequests: Request[] = []
  const model = createModel(async (...args) => {
    capturedRequests.push(new Request(...args))
    return streamResponse()
  })
  const pngData = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlL8AAAAASUVORK5CYII="

  await collectEvents(model, [{
    ...userMessage("Inspect [Image 1]"),
    attachments: [{
      type: "image",
      mimeType: "image/png",
      data: pngData,
      filename: "clipboard-1.png",
      source: { value: "[Image 1]", start: 8, end: 17 },
    }],
  }], [])

  const request = capturedRequests[0]
  if (!request) throw new Error("Expected an OpenAI request")
  const body = (await request.json()) as Record<string, unknown>
  expect(body.input).toEqual([{
    role: "user",
    content: [
      { type: "input_text", text: "Inspect [Image 1]" },
      {
        type: "input_image",
        image_url: `data:image/png;base64,${pngData}`,
      },
    ],
  }])
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
  const events: AgentModelEvent[] = []

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
  expect(body).not.toHaveProperty("parallel_tool_calls")
  expect(body).not.toHaveProperty("service_tier")
  expect(events.at(-1)).toMatchObject({
    type: "finish",
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  })
})

test("sends the priority service tier for a Fast model registration", async () => {
  let capturedRequest: Request | undefined
  const model = createModel(async (...args) => {
    capturedRequest = new Request(...args)
    return streamResponse()
  }, {
    modelId: "gpt-5.4-nano-catalog",
    serviceTier: "priority",
  })

  await collectEvents(model, [userMessage("Fast request")], [])

  if (!capturedRequest) throw new Error("Expected one provider request")
  const body = (await capturedRequest.json()) as Record<string, unknown>
  expect(body.model).toBe("gpt-5.4-nano-catalog")
  expect(body.service_tier).toBe("priority")
})

test("normalizes cache and reasoning usage without double-counting totals", async () => {
  const model = createModel(async () => streamResponse({
    input_tokens: 100,
    input_tokens_details: {
      cached_tokens: 40,
      cache_write_tokens: 10,
    },
    output_tokens: 25,
    output_tokens_details: { reasoning_tokens: 15 },
  }))

  const events = await collectEvents(model, [userMessage("Usage")], [])

  expect(events.at(-1)).toEqual({
    type: "finish",
    reason: "stop",
    usage: {
      inputTokens: 100,
      outputTokens: 25,
      totalTokens: 125,
      cacheReadTokens: 40,
      cacheWriteTokens: 10,
      reasoningTokens: 15,
    },
  })
})

test("uses the unified finish reason instead of the raw provider reason", async () => {
  const model = createModel(async () => eventStream([
    {
      type: "response.created",
      response: {
        id: "response-incomplete",
        created_at: 1,
        model: "gpt-5.6-sol",
        service_tier: null,
      },
    },
    {
      type: "response.incomplete",
      response: {
        incomplete_details: { reason: "max_output_tokens" },
        usage: {
          input_tokens: 1,
          input_tokens_details: null,
          output_tokens: 1,
          output_tokens_details: null,
        },
        service_tier: null,
      },
    },
  ]))

  const events = await collectEvents(model, [userMessage("Long response")], [])

  expect(events.at(-1)).toMatchObject({
    type: "finish",
    reason: "length",
  })
})

test("classifies only explicit OpenAI context-limit failures", async () => {
  const contextModel = createModel(async () => new Response(JSON.stringify({
    error: {
      message: "This model's maximum context length is 200000 tokens",
      type: "invalid_request_error",
      code: "context_length_exceeded",
    },
  }), {
    status: 400,
    headers: { "content-type": "application/json" },
  }))
  const genericModel = createModel(async () => new Response(JSON.stringify({
    error: {
      message: "Invalid tool schema",
      type: "invalid_request_error",
      code: "invalid_tool_schema",
    },
  }), {
    status: 400,
    headers: {
      "content-type": "application/json",
      "x-request-id": "request-invalid-schema",
    },
  }))

  const contextEvents = await collectEvents(
    contextModel,
    [userMessage("Too large")],
    [],
  )
  const genericEvents = await collectEvents(
    genericModel,
    [userMessage("Invalid")],
    [],
  )

  const contextError = contextEvents.find((event) => event.type === "error")
  const genericError = genericEvents.find((event) => event.type === "error")
  expect(contextError?.type).toBe("error")
  expect(contextError?.type === "error"
    && isModelContextOverflowError(contextError.error)).toBe(true)
  expect(genericError?.type).toBe("error")
  expect(genericError?.type === "error"
    && isModelContextOverflowError(genericError.error)).toBe(false)
  expect(genericError?.type === "error"
    && genericError.error instanceof Error
    && genericError.error.message).toBe(
      "OpenAI request failed (400): Invalid tool schema "
      + "[request request-invalid-schema]",
    )
})

test("rejects a discovered model after the authenticated account changes", async () => {
  let networkCalls = 0
  const model = new OpenAiAgentModel({
    auth: {
      authenticatedFetch: fetchImplementation(async () => {
        networkCalls += 1
        return streamResponse()
      }),
      requireCredential: async () => ({ accountId: "account-b" }),
    },
    modelId: "account-a-model",
    expectedAccountId: "account-a",
  })
  const consume = async (): Promise<void> => {
    for await (const _event of model.stream({
      sessionId: "session-1",
      runId: "run-1",
      systemPrompt: "System",
      messages: [userMessage("Hello")],
      tools: [],
      reasoningEffort: "medium",
      signal: new AbortController().signal,
    })) {
      // The account check must fail before a provider event can arrive.
    }
  }

  await expect(consume()).rejects.toThrow(
    "OpenAI account changed; run `/model` to refresh available models",
  )
  expect(networkCalls).toBe(0)
})

test("binds a fallback model request to its preflight account", async () => {
  let boundAccountId: string | undefined
  let reportedAccountId: string | undefined
  let genericNetworkCalls = 0
  const model = new OpenAiAgentModel({
    auth: {
      authenticatedFetch: fetchImplementation(async () => {
        genericNetworkCalls += 1
        return streamResponse()
      }),
      authenticatedFetchForAccount: (accountId) => {
        boundAccountId = accountId
        return fetchImplementation(async () => streamResponse())
      },
      requireCredential: async () => ({ accountId: "account-a" }),
    },
  })

  const events = await collectEvents(
    model,
    [userMessage("Hello")],
    [],
    (accountId) => {
      reportedAccountId = accountId
    },
  )

  expect(boundAccountId).toBe("account-a")
  expect(reportedAccountId).toBe("account-a")
  expect(genericNetworkCalls).toBe(0)
  expect(events.at(-1)?.type).toBe("finish")
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

test("does not execute an OpenAI tool call from an output-limited response", async () => {
  let requests = 0
  let executions = 0
  const model = createModel(async () => {
    requests += 1
    return requests === 1
      ? incompleteToolCallResponse("dangerous_action", { value: "partial" })
      : streamResponse()
  })
  const tool: AgentTool = {
    name: "dangerous_action",
    description: "Perform a local side effect",
    inputSchema: { type: "object" },
    execute: async () => {
      executions += 1
      return "executed"
    },
  }

  const result = await runAgentLoop(
    userMessage("Perform the action"),
    {
      systemPrompt: "System",
      messages: [],
      tools: [tool],
    },
    {
      sessionId: "session-1",
      runId: "run-1",
      model,
      reasoningEffort: "medium",
      signal: new AbortController().signal,
      emit: () => undefined,
    },
  )

  expect(executions).toBe(0)
  expect(requests).toBe(2)
  expect(result.messages.find((message) => message.role === "toolResult"))
    .toMatchObject({
      toolName: "dangerous_action",
      isError: true,
      content: expect.stringContaining("output token limit"),
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

function streamResponse(usage: Record<string, unknown> = {
  input_tokens: 1,
  input_tokens_details: null,
  output_tokens: 1,
  output_tokens_details: null,
}): Response {
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
        usage,
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

function incompleteToolCallResponse(
  toolName: string,
  input: Record<string, unknown>,
): Response {
  return eventStream([
    {
      type: "response.created",
      response: {
        id: "response-incomplete-tool",
        created_at: 1,
        model: "gpt-5.6-sol",
        service_tier: null,
      },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        type: "function_call",
        id: "function-call-incomplete",
        call_id: "call-incomplete",
        name: toolName,
        arguments: "",
      },
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "function_call",
        id: "function-call-incomplete",
        call_id: "call-incomplete",
        name: toolName,
        arguments: JSON.stringify(input),
        status: "completed",
      },
    },
    {
      type: "response.incomplete",
      response: {
        incomplete_details: { reason: "max_output_tokens" },
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
  options: Omit<IOpenAiAgentModelOptions, "auth"> = {},
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
  return new OpenAiAgentModel({ auth, ...options })
}

async function collectEvents(
  model: OpenAiAgentModel,
  messages: readonly AgentMessage[],
  tools: readonly AgentToolDescriptor[],
  reportProviderAccountId?: (accountId: string) => void,
): Promise<AgentModelEvent[]> {
  const events: AgentModelEvent[] = []
  for await (const event of model.stream({
    sessionId: "session-1",
    runId: "run-1",
    systemPrompt: "System",
    messages,
    tools,
    reasoningEffort: "medium",
    signal: new AbortController().signal,
    ...(reportProviderAccountId === undefined
      ? {}
      : { reportProviderAccountId }),
  })) {
    events.push(event)
  }
  return events
}

function userMessage(content: string): UserMessage {
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

function toolDescriptor(name: string): AgentToolDescriptor {
  return {
    name,
    description: `Run ${name}`,
    inputSchema: { type: "object" },
  }
}
