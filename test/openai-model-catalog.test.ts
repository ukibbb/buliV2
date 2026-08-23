import { expect, test } from "bun:test"

import type { IOAuthCredential } from "@/authentication"
import {
  MODELS_DEV_API_URL,
  OPENAI_CODEX_MODELS_URL,
} from "@/providers/openai/constants"
import {
  createOpenAiModelCatalog,
  type IOpenAiModelCatalogAuth,
} from "@/providers/openai/model/openai-model-catalog"

test("uses Codex availability and enriches matching IDs from models.dev", async () => {
  const publicRequests: Array<{
    readonly request: Request
    readonly init: RequestInit | undefined
  }> = []
  const catalog = createOpenAiModelCatalog({
    auth: catalogAuth(async () => Response.json({
      models: [
        {
          slug: "account-only",
          display_name: "Account Only",
          priority: 1,
          supported_reasoning_levels: [{ effort: "high" }],
          default_reasoning_level: "high",
          input_modalities: ["text"],
        },
        {
          slug: "gpt-rich",
          display_name: "gpt-rich",
          priority: 2,
          context_window: 300_000,
          supported_reasoning_levels: ["medium", "low", "future"],
          default_reasoning_level: "medium",
          input_modalities: ["text", "image"],
        },
        {
          slug: "gpt-enriched",
          priority: 3,
          default_reasoning_level: "high",
          input_modalities: ["text"],
        },
        {
          slug: "hidden-model",
          visibility: "hidden",
          supported_reasoning_levels: ["medium"],
        },
        {
          slug: "image-only",
          input_modalities: ["image"],
          supported_reasoning_levels: ["medium"],
        },
      ],
    })),
    fetch: fetchImplementation(async (input, init) => {
      publicRequests.push({ request: new Request(input, init), init })
      return Response.json({
        openai: {
          models: {
            alias: {
              id: "gpt-rich",
              name: "GPT Rich Published",
              reasoning_options: [{
                type: "effort",
                values: [null, "max"],
              }],
            },
            "gpt-enriched": {
              id: "gpt-enriched",
              name: "GPT Enriched",
              reasoning_options: [{
                type: "effort",
                values: ["low", "high", "max"],
              }],
            },
            "models-dev-only": {
              id: "models-dev-only",
              name: "Must Not Appear",
              reasoning: false,
            },
          },
        },
      })
    }),
  })

  const models = await catalog.load()

  expect(models).toEqual([
    {
      id: "account-only",
      accountId: "account-id",
      name: "Account Only",
      reasoningEfforts: ["high"],
      defaultReasoningEffort: "high",
    },
    {
      id: "gpt-rich",
      accountId: "account-id",
      name: "GPT Rich Published",
      reasoningEfforts: ["low", "medium"],
      defaultReasoningEffort: "medium",
      contextWindowTokens: 300_000,
    },
    {
      id: "gpt-enriched",
      accountId: "account-id",
      name: "GPT Enriched",
      reasoningEfforts: ["low", "high", "max"],
      defaultReasoningEffort: "high",
    },
  ])
  expect(Object.isFrozen(models)).toBe(true)
  expect(Object.isFrozen(models[0])).toBe(true)
  expect(Object.isFrozen(models[0]?.reasoningEfforts)).toBe(true)
  expect(publicRequests).toHaveLength(1)
  expect(publicRequests[0]?.request.url).toBe(MODELS_DEV_API_URL)
  expect(publicRequests[0]?.request.method).toBe("GET")
  expect(publicRequests[0]?.init?.credentials).toBe("omit")
  expect(publicRequests[0]?.request.headers.get("authorization")).toBeNull()
  expect(publicRequests[0]?.request.headers.get("chatgpt-account-id")).toBeNull()
})

test("keeps Codex models when models.dev enrichment fails", async () => {
  const catalog = createOpenAiModelCatalog({
    auth: catalogAuth(async () => Response.json({
      models: [{
        slug: "codex-only",
        display_name: "Codex Only",
        supported_reasoning_levels: ["medium"],
      }],
    })),
    fetch: fetchImplementation(async () => new Response("offline", {
      status: 503,
    })),
  })

  await expect(catalog.load()).resolves.toEqual([{
    id: "codex-only",
    accountId: "account-id",
    name: "Codex Only",
    reasoningEfforts: ["medium"],
    defaultReasoningEffort: "medium",
  }])
})

test("never promotes models.dev models when Codex fails or is empty", async () => {
  const modelsDev = fetchImplementation(async () => Response.json({
    openai: {
      models: {
        public: {
          id: "public",
          name: "Public",
          reasoning: false,
        },
      },
    },
  }))
  const failed = createOpenAiModelCatalog({
    auth: catalogAuth(async () => new Response("failed", { status: 500 })),
    fetch: modelsDev,
  })
  const empty = createOpenAiModelCatalog({
    auth: catalogAuth(async () => Response.json({ models: [] })),
    fetch: modelsDev,
  })

  await expect(failed.load()).rejects.toThrow(
    "OpenAI Codex model catalog returned HTTP 500",
  )
  await expect(empty.load()).rejects.toThrow(
    "OpenAI Codex returned no usable models",
  )
})

test("caches per account and expires entries by TTL", async () => {
  let accountId = "account-a"
  let now = 1_000
  let codexCalls = 0
  const auth = catalogAuth(async () => {
    codexCalls += 1
    return Response.json({
      models: [{
        slug: `model-${accountId}`,
        supported_reasoning_levels: ["medium"],
      }],
    })
  }, () => accountId)
  const catalog = createOpenAiModelCatalog({
    auth,
    fetch: fetchImplementation(async () => Response.json({ openai: { models: {} } })),
    now: () => now,
    ttlMs: 100,
  })

  const firstModels = await catalog.load()
  expect(codexCalls).toBe(1)

  expect(await catalog.load()).toBe(firstModels)
  expect(codexCalls).toBe(1)

  now += 101
  await catalog.load()
  expect(codexCalls).toBe(2)

  accountId = "account-b"
  const secondAccount = await catalog.load()
  expect(codexCalls).toBe(3)
  expect(secondAccount[0]?.id).toBe("model-account-b")
})

test("rejects a catalog fetched with a different account than the cache key", async () => {
  const auth: IOpenAiModelCatalogAuth = {
    async requireCredential() {
      return credential("account-a")
    },
    async fetchModels() {
      return {
        accountId: "account-b",
        response: Response.json({
          models: [{
            slug: "account-b-model",
            supported_reasoning_levels: ["medium"],
          }],
        }),
      }
    },
  }
  const catalog = createOpenAiModelCatalog({
    auth,
    fetch: fetchImplementation(async () => Response.json({ openai: { models: {} } })),
  })

  await expect(catalog.load()).rejects.toThrow(
    "OpenAI account changed while loading models",
  )
})

test("does not let an optional models.dev timeout reject a Codex catalog", async () => {
  const catalog = createOpenAiModelCatalog({
    auth: catalogAuth(async () => Response.json({
      models: [{ slug: "codex-model" }],
    })),
    fetch: fetchImplementation(async (_input, init) => {
      const signal = init?.signal
      if (!signal) throw new Error("Expected a request signal")
      await new Promise<void>((_resolve, reject) => {
        const rejectOnAbort = (): void => reject(signal.reason)
        signal.addEventListener("abort", rejectOnAbort, { once: true })
        if (signal.aborted) rejectOnAbort()
      })
      return Response.json({})
    }),
    timeoutMs: 5,
  })

  await expect(catalog.load()).resolves.toEqual([{
    id: "codex-model",
    accountId: "account-id",
    name: "codex-model",
    reasoningEfforts: ["none"],
    defaultReasoningEffort: "none",
  }])
})

test("rejects and cancels a catalog declared above the response limit", async () => {
  let bodyCancelled = false
  const oversized = new Response(new ReadableStream<Uint8Array>({
    cancel() {
      bodyCancelled = true
    },
  }), {
    headers: { "content-length": String(20 * 1024 * 1024 + 1) },
  })
  const catalog = createOpenAiModelCatalog({
    auth: catalogAuth(async () => oversized),
    fetch: fetchImplementation(async () => Response.json({ openai: { models: {} } })),
  })

  await expect(catalog.load()).rejects.toThrow(
    "OpenAI Codex model catalog is too large",
  )
  expect(bodyCancelled).toBe(true)
})

test("propagates cancellation instead of publishing a partial catalog", async () => {
  const controller = new AbortController()
  const auth = catalogAuth(async (_input, init) => {
    controller.abort(new Error("picker closed"))
    init?.signal?.throwIfAborted()
    return Response.json({ models: [] })
  })
  const catalog = createOpenAiModelCatalog({
    auth,
    fetch: fetchImplementation(async () => Response.json({ openai: { models: {} } })),
  })

  await expect(catalog.load(controller.signal)).rejects.toThrow("picker closed")
})

function catalogAuth(
  codex: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>,
  accountId: () => string = () => "account-id",
): IOpenAiModelCatalogAuth {
  return {
    async requireCredential() {
      return credential(accountId())
    },
    async fetchModels(signal) {
      const response = await codex(
        OPENAI_CODEX_MODELS_URL,
        signal ? { signal } : undefined,
      )
      return { response, accountId: accountId() }
    },
  }
}

function credential(accountId: string): IOAuthCredential {
  return {
    type: "oauth",
    access: "access-token",
    refresh: "refresh-token",
    expires: Number.MAX_SAFE_INTEGER,
    accountId,
  }
}

function fetchImplementation(
  implementation: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>,
): typeof fetch {
  const preconnect: typeof globalThis.fetch.preconnect = () => undefined
  return Object.assign(implementation, { preconnect })
}
