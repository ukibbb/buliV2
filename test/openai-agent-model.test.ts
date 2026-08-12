import { expect, test } from "bun:test"
import { realpathSync } from "node:fs"

import { systemPrompt } from "@/agent/agents-prompts"
import type { IBuliMessageWithParts } from "@/domain"
import type { IAuthStore, TAuthInfo } from "@/providers/auth-store"
import { OpenAiAuth } from "@/providers/openai/openai-auth"
import { OpenAiAgentModel } from "@/providers/openai/openai-agent-model"
import { OPENAI_CODEX_RESPONSES_URL } from "@/providers/openai/openai-constants"
import { AgentSession } from "@/session/agent-session"
import { InMemorySessionManager } from "@/session/session-manager"
import { createWorkspaceTools } from "@/tools/workspace-tools"

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
      return toolCallResponse("read_file", { path: "package.json" })
    }
    return streamResponse()
  })
  const auth = new OpenAiAuth({
    store: authStore({
      type: "oauth",
      access: "test-access-token",
      refresh: "test-refresh-token",
      expires: 200,
      accountId: "test-account-id",
    }),
    fetch: captureFetch,
    now: () => 100,
  })
  const model = new OpenAiAgentModel({
    auth,
    modelId: "gpt-5.6-sol",
  })
  const history: IBuliMessageWithParts[] = [
    message("user", [
      part("text", " First "),
      part("reasoning", "Do not send this"),
      part("text", "Second"),
    ]),
    message("assistant", [part("text", "Answer")]),
  ]
  const manager = new InMemorySessionManager()
  history.forEach(manager.appendMessage)
  const session = new AgentSession({
    sessionId: "session-1",
    manager,
    systemPrompt: systemPrompt(WORKSPACE_ROOT),
    model,
    tools: createWorkspaceTools(WORKSPACE_ROOT),
  })

  await session.prompt("Continue")

  const [firstRequest, secondRequest, thirdRequest, fourthRequest] = capturedRequests
  if (!firstRequest || !secondRequest || !thirdRequest || !fourthRequest) {
    throw new Error("Expected the OpenAI SDK to issue four requests")
  }

  expect(capturedRequests).toHaveLength(4)
  expect(firstRequest.url).toBe(OPENAI_CODEX_RESPONSES_URL)
  expect(firstRequest.headers.get("authorization")).toBe("Bearer test-access-token")
  expect(firstRequest.headers.get("chatgpt-account-id")).toBe("test-account-id")
  expect(firstRequest.headers.get("originator")).toBe("opencode")

  const body = (await firstRequest.json()) as Record<string, unknown>
  expect(body.model).toBe("gpt-5.6-sol")
  expect(body.store).toBe(false)
  expect(body.stream).toBe(true)
  expect(body.instructions).toContain("pair programming")
  expect(body.instructions).toContain(
    `Aktualny katalog roboczy i root workspace: ${WORKSPACE_ROOT}.`,
  )
  expect(body.tools).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: "function", name: "read_file" }),
    expect.objectContaining({ type: "function", name: "glob" }),
    expect.objectContaining({ type: "function", name: "grep" }),
  ]))
  expect(JSON.stringify(body.tools)).not.toContain("write_file")
  expect(JSON.stringify(body.tools)).not.toContain("apply_patch")

  const input = JSON.stringify(body.input)
  expect(input).toContain("First \\n\\nSecond")
  expect(input).toContain("Answer")
  expect(input).toContain("Continue")
  expect(input).not.toContain("Do not send this")

  const globContinuation = (await secondRequest.json()) as Record<string, unknown>
  expect(JSON.stringify(globContinuation.input)).toContain("package.json")

  const grepContinuation = (await thirdRequest.json()) as Record<string, unknown>
  expect(JSON.stringify(grepContinuation.input)).toContain("bun@1.3.12")

  const readContinuation = (await fourthRequest.json()) as Record<string, unknown>
  expect(JSON.stringify(readContinuation.input)).toContain("scripts")

  const stored = manager.getMessages("session-1")
  const tools = stored
    .flatMap((message) => message.parts)
    .filter((part) => part.type === "tool")

  expect(tools).toEqual([
    expect.objectContaining({
      callID: "call-glob",
      tool: "glob",
      status: "completed",
      input: { pattern: "package.json" },
      output: "package.json",
      execution: "local",
    }),
    expect.objectContaining({
      callID: "call-grep",
      tool: "grep",
      status: "completed",
      output: expect.stringContaining("bun@1.3.12"),
      execution: "local",
    }),
    expect.objectContaining({
      callID: "call-read_file",
      tool: "read_file",
      status: "completed",
      output: expect.stringContaining('"scripts"'),
      execution: "local",
    }),
  ])
  expect(stored.at(-1)?.info).toMatchObject({
    role: "assistant",
    finish: "stop",
  })
  expect(stored.at(-1)?.parts).toContainEqual(
    expect.objectContaining({ type: "text", text: "Hello" }),
  )
})

test("replays a local tool failure into the next OAuth iteration", async () => {
  const capturedRequests: Request[] = []
  const missingPath = "__buli_missing_tool_file__.txt"
  const captureFetch = fetchImplementation(async (...args) => {
    capturedRequests.push(new Request(...args))
    return capturedRequests.length === 1
      ? toolCallResponse("read_file", { path: missingPath })
      : streamResponse()
  })
  const auth = new OpenAiAuth({
    store: authStore({
      type: "oauth",
      access: "test-access-token",
      refresh: "test-refresh-token",
      expires: 200,
    }),
    fetch: captureFetch,
    now: () => 100,
  })
  const manager = new InMemorySessionManager()
  const session = new AgentSession({
    sessionId: "session-1",
    manager,
    systemPrompt: systemPrompt(WORKSPACE_ROOT),
    model: new OpenAiAgentModel({
      auth,
    }),
    tools: createWorkspaceTools(WORKSPACE_ROOT),
  })

  await session.prompt("Read the missing file")

  expect(capturedRequests).toHaveLength(2)
  const failedTool = manager
    .getMessages("session-1")
    .flatMap((message) => message.parts)
    .find((part) => part.type === "tool")

  if (failedTool?.type !== "tool" || !failedTool.error) {
    throw new Error("Expected a failed read_file tool")
  }

  expect(failedTool).toMatchObject({
    tool: "read_file",
    status: "error",
    input: { path: missingPath },
  })

  const continuation = capturedRequests[1]
  if (!continuation) throw new Error("Expected a continuation request")
  const body = (await continuation.json()) as Record<string, unknown>
  const input = JSON.stringify(body.input)
  expect(input).toContain(missingPath)
  expect(input).toContain(failedTool.error)
  expect(manager.getMessages("session-1").at(-1)?.info).toMatchObject({
    role: "assistant",
    finish: "stop",
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
      expires: 200,
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
      systemPrompt: systemPrompt(WORKSPACE_ROOT),
      history: [message("user", [part("text", "Wait")])],
      tools: [],
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

function authStore(credential: TAuthInfo): IAuthStore {
  return {
    async all() {
      return { openai: credential }
    },
    async get(providerID) {
      return providerID === "openai" ? credential : undefined
    },
    async set() {
      throw new Error("Test auth store is read-only")
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
  return eventStream([
    {
      type: "response.created",
      response: {
        id: `response-${toolName}`,
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
        id: `function-${toolName}`,
        call_id: `call-${toolName}`,
        name: toolName,
        arguments: "",
      },
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "function_call",
        id: `function-${toolName}`,
        call_id: `call-${toolName}`,
        name: toolName,
        arguments: JSON.stringify(input),
        status: "completed",
      },
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

function eventStream(chunks: readonly Record<string, unknown>[]): Response {
  const body = chunks
    .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
    .join("")

  return new Response(`${body}data: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
  })
}

function message(
  role: "user" | "assistant",
  parts: IBuliMessageWithParts["parts"],
): IBuliMessageWithParts {
  const id = `${role}-message`

  return {
    info: {
      id,
      sessionId: "session-1",
      role,
      createdAt: 1,
      ...(role === "assistant"
        ? { completedAt: 2, finish: "stop" }
        : {}),
    },
    parts: parts.map((item) => ({
      ...item,
      messageId: id,
      sessionId: "session-1",
    })),
  }
}

function part(
  type: "text" | "reasoning",
  text: string,
): IBuliMessageWithParts["parts"][number] {
  return {
    id: `${type}-${text}`,
    messageId: "message",
    sessionId: "session-1",
    createdAt: 1,
    type,
    text,
  }
}
