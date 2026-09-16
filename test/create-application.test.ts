import { expect, mock, test } from "bun:test"
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setImmediate } from "node:timers/promises"

import type { IAgentModelRequest } from "@/agent"
import {
  createBuliApplication,
  type IBuliApplicationOptions,
  type IBuliApplicationStartup,
} from "@/app/bootstrap/create-application"
import { createAuthentication } from "@/app/bootstrap/create-authentication"
import type { IAuthStore, IOAuthCredential, TAuthCredential } from "@/authentication"
import {
  createOpenAiModelCatalog,
  DEFAULT_OPENAI_MODEL_ID,
  type IOpenAiCatalogModel,
} from "@/providers/openai"
import {
  MODELS_DEV_API_URL,
  OPENAI_CODEX_MODELS_URL,
  OPENAI_CODEX_RESPONSES_URL,
} from "@/providers/openai/constants"
import { InMemorySessionManager } from "@/sessions"
import {
  CODEX_ASTRA_REFERENCE,
  MODELS_DEV_ASTRA_REFERENCE,
} from "./fixtures/openai-astra-reference"

const TEST_CREDENTIAL: IOAuthCredential = {
  type: "oauth",
  access: "synthetic-access-token",
  refresh: "synthetic-refresh-token",
  accountId: "synthetic-account-id",
  expires: 1_000_000,
}

test("does not attach OpenAI web search to an injected provider-neutral model", async () => {
  const fixture = await applicationFixture()
  let modelRequest: IAgentModelRequest | undefined

  try {
    await mkdir(join(fixture.workspace, ".buli"))
    await writeFile(
      join(fixture.workspace, ".buli", "AGENTS.md"),
      "Run the project checks before finishing.",
    )
    const startup = await fixture.start({
      model: {
        async *stream(request) {
          modelRequest = request
          yield { type: "finish", reason: "stop" }
        },
      },
    })
    await startup.runtime.refreshModels()
    expect(startup.runtime.getSnapshot()).toMatchObject({
      models: [{
        id: "gpt-6-astra",
        name: "Injected model",
        reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
      }],
      selection: { modelId: "gpt-6-astra", reasoningEffort: "medium" },
    })
    expect(startup.runtime.getSnapshot()).not.toHaveProperty("modelCatalog")

    const promptRun = startup.runtime.submitPrompt({ text: "Search the web" })
    await Promise.all([promptRun.promptPersisted, promptRun.runFinished])

    if (!modelRequest) throw new Error("Expected one model request")
    expect(modelRequest.reasoningEffort).toBe("medium")
    expect(modelRequest.tools.map((tool) => tool.name)).not.toContain("web_search")
    expect(modelRequest.tools.map((tool) => tool.name)).toContain("tool_output")
    expect(modelRequest.tools.map((tool) => tool.name)).toContain("apply_file_changes")
    expect(modelRequest.tools.map((tool) => tool.name)).toContain("reject_file_changes")
    expect(modelRequest.systemPrompt).not.toContain("web_search")
    expect(modelRequest.systemPrompt).toContain("When a result contains outputId")
    expect(modelRequest.systemPrompt).toContain("generate immutable proposals")
    expect(modelRequest.systemPrompt).toContain(
      '<workspace_instructions source=".buli/AGENTS.md">',
    )
    expect(modelRequest.systemPrompt).toContain(
      "Run the project checks before finishing.",
    )
    expect(startup.runtime.workspaceRoot).toBe(await realpath(fixture.workspace))
    const session = startup.runtime.openSession(promptRun.sessionId).getSnapshot()
    const assistant = session.messages.find((message) => message.role === "assistant")
    expect(assistant).toMatchObject({ role: "assistant", stopReason: "stop" })
    expect(assistant).not.toHaveProperty("model")
    expect(session.contextUsage).not.toHaveProperty("contextWindowTokens")
    expect(fixture.modelCatalog.load).not.toHaveBeenCalled()
    expect(fixture.store.get).not.toHaveBeenCalled()
    expect(fixture.accountRequests).toEqual([])
    expect(fixture.modelRequests).toEqual([])
    expect(fixture.publicRequests).toEqual([])
  } finally {
    await fixture.dispose()
  }
})

test.each(["Fast", "Standard"] as const)(
  "waits for account discovery and runs Astra %s through the real SDK",
  async (mode) => {
    const fixture = await applicationFixture()
    const entered = Promise.withResolvers<void>()
    const catalogResponse = Promise.withResolvers<Response>()
    fixture.accountResponse.mockImplementation(() => {
      entered.resolve()
      return catalogResponse.promise
    })

    try {
      const starting = fixture.start()
      let settled = false
      void starting.then(() => { settled = true }, () => { settled = true })
      await Promise.race([entered.promise, starting])
      // Yield a turn with the HTTP response still withheld: startup must not
      // expose an editor that can capture its provisional Standard adapter.
      await setImmediate()
      expect(settled).toBe(false)
      expect(fixture.modelCatalog.load).toHaveBeenCalledTimes(1)
      expect(fixture.accountRequests).toHaveLength(1)
      expect(fixture.modelRequests).toEqual([])
      expect(fixture.manager.listSessions()).toEqual([])

      const {
        service_tiers: _tiers,
        additional_speed_tiers: _speeds,
        ...standard
      } = CODEX_ASTRA_REFERENCE
      // The reference is not an entitlement. Here only the fake account endpoint
      // grants Fast; public Fast metadata remains present in both cases.
      catalogResponse.resolve(Response.json({
        models: [mode === "Fast" ? CODEX_ASTRA_REFERENCE : standard],
      }))
      const { runtime } = await starting
      const selected = mode === "Fast" ? "gpt-6-astra::fast" : "gpt-6-astra"
      expect(DEFAULT_OPENAI_MODEL_ID).toBe("gpt-6-astra")
      expect(runtime.getSnapshot().selection).toEqual({
        modelId: selected,
        reasoningEffort: "low",
      })
      expect(runtime.getSnapshot().models.map((entry) => entry.id)).toEqual(
        mode === "Fast" ? ["gpt-6-astra", "gpt-6-astra::fast"] : ["gpt-6-astra"],
      )
      expect(runtime.getSnapshot().models.find((entry) => entry.id === selected))
        .toEqual({
          id: selected,
          name: `GPT-6-Astra${mode === "Fast" ? " Fast" : ""}`,
          reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
        })
      expect(runtime.getSnapshot().modelCatalog).toEqual({
        status: "ready",
        ...(mode === "Fast" ? {} : {
          message: 'Model "gpt-6-astra::fast" was not returned in the model catalog for your signed-in ChatGPT account. Availability may depend on your plan or account permissions. Using "gpt-6-astra" instead.',
        }),
      })

      let sessionId: string | undefined
      for (const effort of ["low", "max"] as const) {
        if (effort !== "low") runtime.selectReasoningEffort(effort)
        const run = runtime.submitPrompt({
          text: `Answer at ${effort} effort`,
          ...(sessionId === undefined ? {} : { sessionId }),
        })
        sessionId = run.sessionId
        await Promise.all([run.promptPersisted, run.runFinished])
        const request = fixture.modelRequests.at(-1)
        if (!request) throw new Error("Expected a serialized SDK request")
        const body = await request.json()
        expect(body).toMatchObject({
          model: "gpt-6-astra",
          reasoning: { effort, summary: "detailed" },
          store: false,
          stream: true,
        })
        if (mode === "Fast") expect(body.service_tier).toBe("priority")
        else expect(body).not.toHaveProperty("service_tier")
        expect(body).not.toHaveProperty("max_output_tokens")

        const session = runtime.openSession(run.sessionId).getSnapshot()
        // The account's active 272k window, not its 872k maximum or the public
        // API's 1050k limit, must reach both telemetry and persisted provenance.
        expect(session.contextUsage?.contextWindowTokens).toBe(272_000)
        expect(session.messages.at(-1)).toMatchObject({
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "Hello" }],
          model: {
            providerId: "openai",
            modelId: "gpt-6-astra",
            contextWindowTokens: 272_000,
          },
        })
      }
      expect(fixture.modelRequests).toHaveLength(2)
      for (const request of [...fixture.accountRequests, ...fixture.modelRequests]) {
        expect(request.headers.get("authorization")).toBe("Bearer synthetic-access-token")
        expect(request.headers.get("chatgpt-account-id")).toBe("synthetic-account-id")
        expect(request.headers.get("originator")).toBe("buli")
        expect(request.headers.get("openai-beta")).toBe("responses=experimental")
      }
      expect(fixture.publicRequests).toHaveLength(1)
      const publicRequest = fixture.publicRequests[0]
      expect(publicRequest?.request.headers.get("authorization")).toBeNull()
      expect(publicRequest?.request.headers.get("chatgpt-account-id")).toBeNull()
      // Bun's Request does not retain credentials; inspect the actual fetch init.
      expect(publicRequest?.init?.credentials).toBe("omit")
    } finally {
      catalogResponse.resolve(Response.json({ models: [] }))
      await fixture.dispose()
    }
  },
)

test("does not send none for sparse account-authorized Astra when public enrichment fails", async () => {
  const fixture = await applicationFixture()
  fixture.accountResponse.mockReturnValue(Response.json({
    models: [{ slug: "gpt-6-astra", service_tiers: [{ id: "priority" }] }],
  }))
  const modelCatalog = createOpenAiModelCatalog({
    auth: fixture.authentication.openAi,
    fetch: fetchImplementation(async (input) => {
      expect(String(input)).toBe(MODELS_DEV_API_URL)
      return new Response(null, { status: 503 })
    }),
  })
  try {
    const { runtime } = await fixture.start({ modelCatalog })
    expect(runtime.getSnapshot().selection).toEqual({
      modelId: "gpt-6-astra::fast",
      reasoningEffort: "low",
    })
    const run = runtime.submitPrompt({ text: "Answer using the supported default" })
    await Promise.all([run.promptPersisted, run.runFinished])
    expect(fixture.modelRequests).toHaveLength(1)
    expect(await fixture.modelRequests[0]!.json()).toMatchObject({
      model: "gpt-6-astra",
      service_tier: "priority",
      reasoning: { effort: "low" },
    })
    expect(runtime.openSession(run.sessionId).getSnapshot().contextUsage)
      .not.toHaveProperty("contextWindowTokens")
  } finally {
    await fixture.dispose()
  }
})

test("forwards catalog reasoning capability for an unknown ID without synthesizing Astra", async () => {
  const fixture = await applicationFixture()
  // Astra has an exact-ID reasoning override. An unknown, non-GPT ID ensures
  // this assertion fails if bootstrap drops the catalog's supportsReasoning.
  fixture.accountResponse.mockReturnValue(Response.json({
    models: [{
      slug: "account-reasoner",
      supported_reasoning_levels: [{ effort: "high" }],
      default_reasoning_level: "high",
    }],
  }))
  try {
    const { runtime } = await fixture.start()
    expect(runtime.getSnapshot().models.map((entry) => entry.id)).toEqual(["account-reasoner"])
    expect(runtime.getSnapshot().selection).toEqual({
      modelId: "account-reasoner",
      reasoningEffort: "high",
    })
    const run = runtime.submitPrompt({ text: "Use the account reasoning capability" })
    await Promise.all([run.promptPersisted, run.runFinished])
    expect(fixture.modelRequests).toHaveLength(1)
    const request = fixture.modelRequests[0]
    if (!request) throw new Error("Expected a serialized SDK request")
    const body = await request.json()
    expect(body.model).toBe("account-reasoner")
    expect(body.reasoning).toEqual({ effort: "high", summary: "detailed" })
    expect(body).not.toHaveProperty("service_tier")
    expect(body).not.toHaveProperty("max_output_tokens")
    expect(fixture.manager.getMessages(run.sessionId).at(-1)).toMatchObject({
      role: "assistant",
      stopReason: "stop",
    })
  } finally {
    await fixture.dispose()
  }
})

test.each(["missing authentication", "catalog HTTP 503"] as const)(
  "%s leaves a login-ready runtime but blocks persistence and generation until retry",
  async (failure) => {
    const fixture = await applicationFixture()
    const retryResponse = Promise.withResolvers<Response>()
    try {
      if (failure === "missing authentication") await fixture.store.remove("openai")
      else fixture.accountResponse.mockReturnValueOnce(new Response("offline", { status: 503 }))
      const { runtime, authentication } = await fixture.start()
      const message = failure === "missing authentication"
        ? "OpenAI is not connected"
        : "OpenAI Codex model catalog returned HTTP 503"
      expect(runtime.getSnapshot().modelCatalog).toMatchObject({
        status: "error",
        message: expect.stringContaining(message),
      })
      expect(runtime.getSnapshot().models).toEqual([])
      const [provider] = await authentication.listProviders()
      expect(provider).toMatchObject({
        providerId: "openai",
        connected: failure !== "missing authentication",
      })
      expect(provider?.methods).toHaveLength(2)
      expect(runtime.listSessions()).toEqual([])
      expect(() => runtime.submitPrompt({ text: "Not yet" })).toThrow("Model catalog unavailable")

      const statuses: (string | undefined)[] = []
      const unsubscribe = runtime.subscribe(() => {
        statuses.push(runtime.getSnapshot().modelCatalog?.status)
      })
      if (failure === "missing authentication") {
        // Simulate completed login only in memory, never through an OAuth endpoint.
        await fixture.store.set("openai", TEST_CREDENTIAL)
      }
      fixture.accountResponse.mockImplementation(() => retryResponse.promise)
      const retry = runtime.refreshModels()
      void retry.catch(() => {})
      expect(runtime.getSnapshot().modelCatalog).toEqual({ status: "loading" })
      expect(runtime.getSnapshot().models).toEqual([])
      expect(() => runtime.submitPrompt({ text: "Still not ready" })).toThrow("Model catalog is loading")
      expect(fixture.manager.createSession).not.toHaveBeenCalled()
      expect(fixture.manager.appendMessage).not.toHaveBeenCalled()
      expect(fixture.manager.getAllMessages()).toEqual([])
      expect(fixture.modelRequests).toEqual([])

      retryResponse.resolve(Response.json({ models: [CODEX_ASTRA_REFERENCE] }))
      await retry
      expect(fixture.modelCatalog.load).toHaveBeenCalledTimes(2)
      expect(statuses).toEqual(["loading", "ready"])
      unsubscribe()
      expect(runtime.getSnapshot().modelCatalog).toEqual({ status: "ready" })
      expect(runtime.getSnapshot().selection).toEqual({
        modelId: "gpt-6-astra::fast",
        reasoningEffort: "low",
      })
      const run = runtime.submitPrompt({ text: "Now ready" })
      await Promise.all([run.promptPersisted, run.runFinished])
      expect(fixture.modelRequests).toHaveLength(1)
      expect(fixture.manager.createSession).toHaveBeenCalledTimes(1)
      expect(fixture.manager.getMessages(run.sessionId).map((entry) => entry.role))
        .toEqual(["user", "assistant"])
      expect(fixture.manager.getMessages(run.sessionId).at(-1)).toMatchObject({ stopReason: "stop" })
    } finally {
      retryResponse.resolve(Response.json({ models: [] }))
      await fixture.dispose()
    }
  },
)

test("root abort during discovery rejects only after owned resources finish rollback", async () => {
  const fixture = await applicationFixture()
  const entered = Promise.withResolvers<AbortSignal>()
  const catalogResult = Promise.withResolvers<readonly IOpenAiCatalogModel[]>()
  const disposing = Promise.withResolvers<void>()
  const releaseDisposal = Promise.withResolvers<void>()
  fixture.manager.dispose.mockImplementation(async () => {
    disposing.resolve()
    await releaseDisposal.promise
  })

  try {
    const starting = fixture.start({
      modelCatalog: {
        load: async (signal) => {
          if (!signal) throw new Error("Expected a discovery cancellation signal")
          entered.resolve(signal)
          return catalogResult.promise
        },
      },
    })
    let settled = false
    void starting.then(() => { settled = true }, () => { settled = true })
    const discoverySignal = await Promise.race([
      entered.promise,
      starting.then(() => { throw new Error("Startup skipped discovery") }),
    ])
    const reason = new DOMException("Root cancelled discovery", "AbortError")
    fixture.controller.abort(reason)
    await disposing.promise
    await setImmediate()
    expect(discoverySignal.aborted).toBe(true)
    // An uncancellable catalog must not hold shutdown open, but owned disposal
    // must complete before the caller observes the original root abort reason.
    expect(settled).toBe(false)
    releaseDisposal.resolve()
    await expect(starting).rejects.toBe(reason)
    expect(fixture.manager.dispose).toHaveBeenCalledTimes(1)
    await expect(fixture.authentication.service.listProviders()).rejects.toBe(reason)
    await expect(fixture.authentication.openAi.getCredential()).rejects.toBe(reason)
    expect(fixture.manager.createSession).not.toHaveBeenCalled()
    expect(fixture.manager.appendMessage).not.toHaveBeenCalled()
    expect(fixture.accountRequests).toEqual([])
    expect(fixture.modelRequests).toEqual([])
    expect(fixture.publicRequests).toEqual([])
    for (const write of [
      fixture.store.set, fixture.store.remove, fixture.store.modify,
      fixture.store.beginOperation, fixture.store.commitOperation,
    ]) expect(write).not.toHaveBeenCalled()
    // All auth/session storage is in memory; never inspect or redirect real HOME.
    // Bootstrap may prepare .buli, but cancellation must not persist anything.
    expect(await readdir(fixture.workspace)).toEqual([".buli"])
    expect(await readdir(join(fixture.workspace, ".buli"))).toEqual([])
  } finally {
    releaseDisposal.resolve()
    catalogResult.resolve([])
    await fixture.dispose()
  }
})

async function applicationFixture() {
  const workspace = await mkdtemp(join(tmpdir(), "buli-application-"))
  const controller = new AbortController()
  const store = memoryAuthStore()
  const memory = new InMemorySessionManager()
  const manager = Object.assign(memory, {
    createSession: mock(memory.createSession),
    appendMessage: mock(memory.appendMessage),
    dispose: mock(async () => {}),
  })
  const accountRequests: Request[] = []
  const modelRequests: Request[] = []
  const publicRequests: Array<{ request: Request; init: RequestInit | undefined }> = []
  const unexpectedUrls: string[] = []
  const accountResponse = mock((_request: Request): Response | Promise<Response> => (
    Response.json({ models: [CODEX_ASTRA_REFERENCE] })
  ))
  const authentication = createAuthentication({
    store,
    now: () => 100,
    fetch: fetchImplementation(async (...args) => {
      const request = new Request(...args)
      if (request.url === OPENAI_CODEX_MODELS_URL && request.method === "GET") {
        accountRequests.push(request)
        return accountResponse(request)
      }
      if (request.url === OPENAI_CODEX_RESPONSES_URL && request.method === "POST") {
        modelRequests.push(request)
        const body = await request.clone().json() as { model: string }
        return streamResponse(body.model)
      }
      unexpectedUrls.push(request.url)
      throw new Error(`Unexpected authenticated HTTP request: ${request.url}`)
    }),
  })
  const catalog = createOpenAiModelCatalog({
    auth: authentication.openAi,
    fetch: fetchImplementation(async (input, init) => {
      const request = new Request(input, init)
      if (request.url !== MODELS_DEV_API_URL || request.method !== "GET") {
        unexpectedUrls.push(request.url)
        throw new Error(`Unexpected public HTTP request: ${request.url}`)
      }
      publicRequests.push({ request, init })
      return Response.json({ openai: { models: {
        "gpt-6-astra": MODELS_DEV_ASTRA_REFERENCE,
        // Public metadata can enrich an account ID, never invent availability.
        "public-only": { ...MODELS_DEV_ASTRA_REFERENCE, id: "public-only" },
      } } })
    }),
  })
  const modelCatalog = { load: mock(catalog.load) }
  let startupTask: Promise<IBuliApplicationStartup> | undefined

  return {
    workspace, controller, store, manager, authentication, modelCatalog,
    accountResponse, accountRequests, modelRequests, publicRequests,
    start(options: Pick<IBuliApplicationOptions, "model" | "modelCatalog"> = {}) {
      if (startupTask) throw new Error("Fixture already started")
      startupTask = createBuliApplication({
        signal: controller.signal,
        workspaceRoot: workspace,
        manager,
        authentication,
        modelCatalog,
        // Preserve the original neutral-model test's default tool composition;
        // HTTP-focused cases need only model traffic, never executable sidecars.
        ...(options.model === undefined ? { tools: [] } : {}),
        ...options,
      })
      void startupTask.catch(() => {})
      return startupTask
    },
    async dispose() {
      controller.abort(new DOMException("Test cleanup", "AbortError"))
      try {
        const startup = await startupTask?.catch(() => undefined)
        await startup?.dispose()
      } finally {
        try {
          // Also covers failures before bootstrap takes ownership of auth.
          await authentication.service.dispose()
        } finally {
          await rm(workspace, { recursive: true, force: true })
        }
      }
      // Optional public-enrichment errors are swallowed by production code;
      // unexpected routes must still fail the test rather than hide in that catch.
      expect(unexpectedUrls).toEqual([])
    },
  }
}

function memoryAuthStore() {
  const credentials = new Map<string, TAuthCredential>([["openai", TEST_CREDENTIAL]])
  const generations = new Map<string, number>()
  const invalidate = (providerId: string): number => {
    const next = (generations.get(providerId) ?? 0) + 1
    generations.set(providerId, next)
    return next
  }
  return {
    get: mock<IAuthStore["get"]>(async (id, signal) => {
      signal?.throwIfAborted()
      return structuredClone(credentials.get(id))
    }),
    set: mock<IAuthStore["set"]>(async (id, next, signal) => {
      signal?.throwIfAborted()
      credentials.set(id, structuredClone(next))
      invalidate(id)
    }),
    remove: mock<IAuthStore["remove"]>(async (id, signal) => {
      signal?.throwIfAborted()
      invalidate(id)
      return credentials.delete(id)
    }),
    modify: mock<IAuthStore["modify"]>(async (id, update, signal) => {
      signal?.throwIfAborted()
      const next = await update(structuredClone(credentials.get(id)))
      signal?.throwIfAborted()
      if (next === undefined) credentials.delete(id)
      else credentials.set(id, structuredClone(next))
      invalidate(id)
      return structuredClone(next)
    }),
    beginOperation: mock<IAuthStore["beginOperation"]>(async (id, signal) => {
      signal?.throwIfAborted()
      return invalidate(id)
    }),
    commitOperation: mock<IAuthStore["commitOperation"]>(async (id, operation, next, signal) => {
      signal?.throwIfAborted()
      if (generations.get(id) !== operation) return false
      credentials.set(id, structuredClone(next))
      invalidate(id)
      return true
    }),
  } satisfies IAuthStore
}

function fetchImplementation(
  run: (...args: Parameters<typeof fetch>) => Promise<Response>,
): typeof fetch {
  return Object.assign(run, { preconnect: () => undefined })
}

function streamResponse(model: string): Response {
  const events = [
    {
      type: "response.created",
      response: { id: "response-1", created_at: 1, model, service_tier: null },
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
        service_tier: null,
        usage: {
          input_tokens: 1,
          input_tokens_details: null,
          output_tokens: 1,
          output_tokens_details: null,
        },
      },
    },
  ]
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  )
}
