import { expect, test } from "bun:test"

import type { IOAuthCredential } from "@/authentication"
import {
  OPENAI_CODEX_CLIENT_VERSION,
  OPENAI_CODEX_SEARCH_URL,
  OPENAI_OAUTH_ORIGINATOR,
} from "@/providers/openai/constants"
import {
  createOpenAiCodexSearch,
  type IOpenAiCodexCredentialProvider,
} from "@/providers/openai/transport/codex-fetch"

test("sends an exact bounded Codex search request and parses public output", async () => {
  const credentials = new StubCredentialProvider(
    credential("search-access", "search-account"),
  )
  let outbound: Request | undefined
  let outboundInit: RequestInit | undefined
  const search = createOpenAiCodexSearch({
    credentials,
    fetch: fetchImplementation(async (input, init) => {
      outbound = new Request(input, init)
      outboundInit = init
      return Response.json({
        encrypted_output: "host-only-ciphertext",
        output: "Search output",
        results: [{ url: "https://example.com/result" }],
      })
    }),
  })
  const controller = new AbortController()
  const request = {
    id: "session-1",
    model: "gpt-5.6-sol",
    commands: { search_query: [{ q: "current news" }] },
    settings: {
      allowed_callers: ["direct"],
      external_web_access: true,
    },
    max_output_tokens: 8_000,
  }

  const result = await search(request, { signal: controller.signal })

  expect(result).toEqual({
    output: "Search output",
    results: [{ url: "https://example.com/result" }],
  })
  if (!outbound) throw new Error("Expected one search request")
  expect(outbound.url).toBe(OPENAI_CODEX_SEARCH_URL)
  expect(outbound.method).toBe("POST")
  expect(await outbound.json()).toEqual(request)
  expect(outbound.headers.get("accept")).toBe("application/json")
  expect(outbound.headers.get("content-type")).toBe("application/json")
  expect(outbound.headers.get("authorization")).toBe("Bearer search-access")
  expect(outbound.headers.get("chatgpt-account-id")).toBe("search-account")
  expect(outbound.headers.get("originator")).toBe(OPENAI_OAUTH_ORIGINATOR)
  expect(outbound.headers.get("openai-beta")).toBe("responses=experimental")
  expect(outbound.headers.get("version")).toBe(OPENAI_CODEX_CLIENT_VERSION)
  expect(outboundInit?.redirect).toBe("error")
  expect(outboundInit?.credentials).toBe("omit")
  expect(credentials.requireSignals).toEqual([controller.signal])
})

test("cancels a search 401, refreshes once, and replays the same body", async () => {
  const credentials = new StubCredentialProvider(
    credential("old-access", "account-id"),
    credential("new-access", "account-id"),
  )
  let firstBodyCancelled = false
  const firstResponse = new Response(new ReadableStream<Uint8Array>({
    cancel() {
      firstBodyCancelled = true
    },
  }), { status: 401 })
  const requests: Request[] = []
  const search = createOpenAiCodexSearch({
    credentials,
    fetch: fetchImplementation(async (input, init) => {
      requests.push(new Request(input, init))
      return requests.length === 1
        ? firstResponse
        : Response.json({ output: "refreshed result" })
    }),
  })
  const controller = new AbortController()
  const request = {
    id: "session-1",
    model: "gpt-5.6-sol",
    commands: { search_query: [{ q: "query" }] },
  }

  await expect(search(request, { signal: controller.signal })).resolves.toEqual({
    output: "refreshed result",
  })

  expect(firstBodyCancelled).toBe(true)
  expect(requests).toHaveLength(2)
  expect(requests[0]?.headers.get("authorization")).toBe("Bearer old-access")
  expect(requests[1]?.headers.get("authorization")).toBe("Bearer new-access")
  expect(await requests[0]?.json()).toEqual(request)
  expect(await requests[1]?.json()).toEqual(request)
  expect(credentials.refreshCalls).toEqual([{
    observedAccessToken: "old-access",
    observedAccountId: "account-id",
    signal: controller.signal,
  }])
})

test("rejects oversized search requests before reading OAuth credentials", async () => {
  const credentials = new StubCredentialProvider(
    credential("access", "account-id"),
  )
  let networkCalls = 0
  const search = createOpenAiCodexSearch({
    credentials,
    fetch: fetchImplementation(async () => {
      networkCalls += 1
      return Response.json({ output: "unexpected" })
    }),
  })

  await expect(search({ query: "x".repeat(129 * 1024) })).rejects.toThrow(
    "OpenAI web search request is too large",
  )
  expect(credentials.requireSignals).toHaveLength(0)
  expect(credentials.refreshCalls).toHaveLength(0)
  expect(networkCalls).toBe(0)
})

test("rejects an account switch before sending search context", async () => {
  const credentials = new StubCredentialProvider(
    credential("access", "new-account"),
  )
  let networkCalls = 0
  const search = createOpenAiCodexSearch({
    credentials,
    fetch: fetchImplementation(async () => {
      networkCalls += 1
      return Response.json({ output: "unexpected" })
    }),
  })

  await expect(search({ id: "session-1" }, {
    expectedAccountId: "original-account",
  })).rejects.toThrow(
    "OpenAI account changed; run `/model` to refresh available models",
  )
  expect(networkCalls).toBe(0)
})

test("cancels search responses larger than the bounded payload", async () => {
  let bodyCancelled = false
  const credentials = new StubCredentialProvider(
    credential("access", "account-id"),
  )
  const search = createOpenAiCodexSearch({
    credentials,
    fetch: fetchImplementation(async () => new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          bodyCancelled = true
        },
      }),
      {
        headers: { "Content-Length": String(2 * 1024 * 1024 + 1) },
      },
    )),
  })

  await expect(search({ id: "session-1" })).rejects.toThrow(
    "OpenAI web search response is too large",
  )
  expect(bodyCancelled).toBe(true)
})

test("enforces the response limit when content length is not declared", async () => {
  let bodyCancelled = false
  const credentials = new StubCredentialProvider(
    credential("access", "account-id"),
  )
  const search = createOpenAiCodexSearch({
    credentials,
    fetch: fetchImplementation(async () => new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1))
        },
        cancel() {
          bodyCancelled = true
        },
      }),
    )),
  })

  await expect(search({ id: "session-1" })).rejects.toThrow(
    "OpenAI web search response is too large",
  )
  expect(bodyCancelled).toBe(true)
})

test("does not expose malformed or failed search response bodies", async () => {
  const secretBody = "server-secret-body"
  const credentials = new StubCredentialProvider(
    credential("access", "account-id"),
  )
  const failedSearch = createOpenAiCodexSearch({
    credentials,
    fetch: fetchImplementation(async () => new Response(secretBody, { status: 500 })),
  })

  const failure = failedSearch({ id: "session-1" }).catch((error: unknown) => error)
  await expect(failure).resolves.toMatchObject({
    message: "OpenAI web search failed with HTTP 500",
  })
  expect(String(await failure)).not.toContain(secretBody)

  const malformedSearch = createOpenAiCodexSearch({
    credentials,
    fetch: fetchImplementation(async () => Response.json({ results: [] })),
  })
  await expect(malformedSearch({ id: "session-1" })).rejects.toThrow(
    "OpenAI web search returned an invalid response",
  )
})

interface IRefreshCall {
  readonly observedAccessToken: string
  readonly observedAccountId: string
  readonly signal: AbortSignal | undefined
}

class StubCredentialProvider implements IOpenAiCodexCredentialProvider {
  readonly requireSignals: Array<AbortSignal | undefined> = []
  readonly refreshCalls: IRefreshCall[] = []

  constructor(
    private readonly requiredCredential: IOAuthCredential,
    private readonly refreshedCredential: IOAuthCredential = requiredCredential,
  ) {}

  async requireCredential(signal?: AbortSignal): Promise<IOAuthCredential> {
    this.requireSignals.push(signal)
    return this.requiredCredential
  }

  async refreshAfterUnauthorized(
    observedAccessToken: string,
    observedAccountId: string,
    signal?: AbortSignal,
  ): Promise<IOAuthCredential> {
    this.refreshCalls.push({ observedAccessToken, observedAccountId, signal })
    return this.refreshedCredential
  }
}

function credential(access: string, accountId: string): IOAuthCredential {
  return {
    type: "oauth",
    access,
    refresh: "refresh-token",
    expires: 1_000,
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
