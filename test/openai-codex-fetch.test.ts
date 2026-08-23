import { expect, test } from "bun:test"

import type { IOAuthCredential } from "@/authentication/credentials"
import {
    OPENAI_CODEX_CLIENT_VERSION,
    OPENAI_CODEX_MODELS_URL,
    OPENAI_CODEX_RESPONSES_URL,
    OPENAI_OAUTH_DUMMY_API_KEY,
    OPENAI_OAUTH_ORIGINATOR,
} from "@/providers/openai/constants"
import {
    createOpenAiCodexFetch,
    createOpenAiCodexModelsFetch,
    type IOpenAiCodexCredentialProvider,
} from "@/providers/openai/transport/codex-fetch"

test("sends an exact Codex models GET with isolated OAuth headers", async () => {
    const provider = new StubCredentialProvider(
        credential("models-access", "models-account"),
    )
    let outbound: Request | undefined
    const codexFetch = createOpenAiCodexFetch({
        credentials: provider,
        fetch: fetchImplementation(async (input, init) => {
            outbound = new Request(input, init)
            return Response.json({ models: [] })
        }),
    })

    await codexFetch(OPENAI_CODEX_MODELS_URL, {
        method: "GET",
        headers: {
            Authorization: "Bearer caller-token",
            cookie: "session=secret",
            "x-caller-header": "discarded",
        },
    })

    if (!outbound) throw new Error("Expected one models request")
    expect(outbound.url).toBe(OPENAI_CODEX_MODELS_URL)
    expect(outbound.method).toBe("GET")
    expect(outbound.body).toBeNull()
    expect(outbound.headers.get("accept")).toBe("application/json")
    expect(outbound.headers.get("authorization")).toBe("Bearer models-access")
    expect(outbound.headers.get("chatgpt-account-id")).toBe("models-account")
    expect(outbound.headers.get("originator")).toBe(OPENAI_OAUTH_ORIGINATOR)
    expect(outbound.headers.get("openai-beta")).toBe("responses=experimental")
    expect(outbound.headers.get("version")).toBe(OPENAI_CODEX_CLIENT_VERSION)
    expect(outbound.headers.get("cookie")).toBeNull()
    expect(outbound.headers.get("x-caller-header")).toBeNull()
})

test("reports the credential account that authorized model discovery", async () => {
    const provider = new StubCredentialProvider(
        credential("old-access", "account-id"),
        credential("new-access", "account-id"),
    )
    const requests: Request[] = []
    const modelsFetch = createOpenAiCodexModelsFetch({
        credentials: provider,
        fetch: fetchImplementation(async (input, init) => {
            requests.push(new Request(input, init))
            return requests.length === 1
                ? new Response("unauthorized", { status: 401 })
                : Response.json({ models: [] })
        }),
    })

    const result = await modelsFetch()

    expect(result.accountId).toBe("account-id")
    expect(result.response.status).toBe(200)
    expect(requests).toHaveLength(2)
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer old-access")
    expect(requests[1]?.headers.get("authorization")).toBe("Bearer new-access")
    expect(provider.refreshCalls).toHaveLength(1)
})

test("an account-bound response transport rejects a switched credential", async () => {
    const provider = new StubCredentialProvider(
        credential("account-b-access", "account-b"),
    )
    let networkCalls = 0
    const codexFetch = createOpenAiCodexFetch({
        credentials: provider,
        expectedAccountId: "account-a",
        fetch: fetchImplementation(async () => {
            networkCalls += 1
            return new Response("unexpected")
        }),
    })

    await expect(codexFetch(
        OPENAI_CODEX_RESPONSES_URL,
        jsonPost(),
    )).rejects.toThrow(
        "OpenAI account changed; run `/model` to refresh available models",
    )
    expect(networkCalls).toBe(0)
})

test("sends an exact Codex request with OAuth headers and buffered body", async () => {
    const provider = new StubCredentialProvider(
        credential("access-token", "account-id"),
    )
    const calls: IFetchCall[] = []
    const rawFetch = fetchImplementation(async (input, init) => {
        calls.push({ input, init })
        return new Response("ok")
    })
    const codexFetch = createOpenAiCodexFetch({
        credentials: provider,
        fetch: rawFetch,
    })
    const sourceController = new AbortController()
    const overrideController = new AbortController()
    const payload = JSON.stringify({ model: "gpt-5.6-sol", stream: true })
    const input = new Request(OPENAI_CODEX_RESPONSES_URL, {
        method: "POST",
        headers: {
            Accept: "text/event-stream",
            Authorization: `Bearer ${OPENAI_OAUTH_DUMMY_API_KEY}`,
            "Content-Type": "Application/JSON; charset=utf-8",
            "x-stainless-retry-count": "0",
        },
        body: payload,
        signal: sourceController.signal,
    })

    await expect(codexFetch(input, {
        signal: overrideController.signal,
    })).resolves.toHaveProperty("status", 200)

    expect(provider.requireSignals).toEqual([overrideController.signal])
    expect(calls).toHaveLength(1)
    const call = calls[0]
    if (!call) throw new Error("Expected one raw fetch call")
    expect(call.input).toBe(OPENAI_CODEX_RESPONSES_URL)
    expect(call.init?.redirect).toBe("error")
    expect(call.init?.credentials).toBe("omit")
    expect(call.init?.signal).toBe(overrideController.signal)

    const outbound = new Request(call.input, call.init)
    expect(outbound.url).toBe(OPENAI_CODEX_RESPONSES_URL)
    expect(outbound.method).toBe("POST")
    expect(await outbound.text()).toBe(payload)
    expect(outbound.headers.get("content-type"))
        .toBe("Application/JSON; charset=utf-8")
    expect(outbound.headers.get("accept")).toBe("text/event-stream")
    expect(outbound.headers.get("x-stainless-retry-count")).toBe("0")
    expect(outbound.headers.get("authorization")).toBe("Bearer access-token")
    expect(outbound.headers.get("chatgpt-account-id")).toBe("account-id")
    expect(outbound.headers.get("originator")).toBe(OPENAI_OAUTH_ORIGINATOR)
    expect(outbound.headers.get("openai-beta")).toBe("responses=experimental")
})

test("rejects requests outside the exact JSON POST contract before auth", async () => {
    const provider = new StubCredentialProvider(
        credential("access-token", "account-id"),
    )
    let networkCalls = 0
    const codexFetch = createOpenAiCodexFetch({
        credentials: provider,
        fetch: fetchImplementation(async () => {
            networkCalls += 1
            return new Response("unexpected")
        }),
    })
    const invalidRequests: Array<readonly [RequestInfo | URL, RequestInit]> = [
        ["https://api.openai.com/backend-api/codex/responses", jsonPost()],
        ["https://chatgpt.com.evil.test/backend-api/codex/responses", jsonPost()],
        ["https://chatgpt.com/backend-api/codex/response", jsonPost()],
        [`${OPENAI_CODEX_RESPONSES_URL}?model=gpt-5.6-sol`, jsonPost()],
        [`${OPENAI_CODEX_RESPONSES_URL}#fragment`, jsonPost()],
        ["https://user@chatgpt.com/backend-api/codex/responses", jsonPost()],
        ["https://chatgpt.com:444/backend-api/codex/responses", jsonPost()],
        [OPENAI_CODEX_MODELS_URL.replace("?", "?unexpected=true&"), {
            method: "GET",
        }],
        [`${OPENAI_CODEX_MODELS_URL}#fragment`, { method: "GET" }],
        [OPENAI_CODEX_MODELS_URL, { method: "POST" }],
        [OPENAI_CODEX_RESPONSES_URL, {
            method: "GET",
            headers: { "Content-Type": "application/json" },
        }],
        [OPENAI_CODEX_RESPONSES_URL, {
            method: "POST",
            headers: { "Content-Type": "text/plain" },
            body: "{}",
        }],
        [OPENAI_CODEX_RESPONSES_URL, {
            method: "POST",
            body: "{}",
        }],
    ]

    for (const [input, init] of invalidRequests) {
        await expect(codexFetch(input, init)).rejects.toThrow()
    }

    expect(provider.requireSignals).toHaveLength(0)
    expect(provider.refreshCalls).toHaveLength(0)
    expect(networkCalls).toBe(0)
})

test("strips caller auth, account, cookie, OpenAI, and hop-by-hop headers", async () => {
    const provider = new StubCredentialProvider(
        credential("real-access-token", "real-account-id"),
    )
    let outboundHeaders: Headers | undefined
    let outboundCredentials: RequestCredentials | undefined
    const codexFetch = createOpenAiCodexFetch({
        credentials: provider,
        fetch: fetchImplementation(async (_input, init) => {
            outboundHeaders = new Headers(init?.headers)
            outboundCredentials = init?.credentials
            return new Response("ok")
        }),
    })

    await codexFetch(OPENAI_CODEX_RESPONSES_URL, {
        method: "POST",
        credentials: "include",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${OPENAI_OAUTH_DUMMY_API_KEY}`,
            "ChatGPT-Account-Id": "caller-account",
            originator: "caller",
            cookie: "session=secret",
            "proxy-authorization": "Basic secret",
            "x-api-key": OPENAI_OAUTH_DUMMY_API_KEY,
            "OpenAI-Organization": "caller-organization",
            "OpenAI-Project": "caller-project",
            "OpenAI-Beta": "caller-beta",
            host: "attacker.test",
            connection: "keep-alive",
            "transfer-encoding": "chunked",
            "x-safe-sdk-header": "preserved",
        },
        body: "{}",
    })

    if (!outboundHeaders) throw new Error("Expected outbound headers")
    expect(outboundHeaders.get("authorization"))
        .toBe("Bearer real-access-token")
    expect(outboundHeaders.get("chatgpt-account-id")).toBe("real-account-id")
    expect(outboundHeaders.get("originator")).toBe(OPENAI_OAUTH_ORIGINATOR)
    expect(outboundHeaders.get("cookie")).toBeNull()
    expect(outboundHeaders.get("proxy-authorization")).toBeNull()
    expect(outboundHeaders.get("x-api-key")).toBeNull()
    expect(outboundHeaders.get("openai-organization")).toBeNull()
    expect(outboundHeaders.get("openai-project")).toBeNull()
    expect(outboundHeaders.get("openai-beta")).toBe("responses=experimental")
    expect(outboundHeaders.get("host")).toBeNull()
    expect(outboundHeaders.get("connection")).toBeNull()
    expect(outboundHeaders.get("transfer-encoding")).toBeNull()
    expect(outboundHeaders.get("x-safe-sdk-header")).toBe("preserved")
    expect(outboundCredentials).toBe("omit")

    let serializedHeaders = ""
    outboundHeaders.forEach((value) => {
        serializedHeaders += value
    })
    expect(serializedHeaders).not.toContain(OPENAI_OAUTH_DUMMY_API_KEY)
})

test("cancels a 401 body, refreshes the observed token, and replays once", async () => {
    const provider = new StubCredentialProvider(
        credential("old-access-token", "old-account-id"),
        credential("new-access-token", "old-account-id"),
    )
    let firstBodyCancelled = false
    const firstResponse = new Response(new ReadableStream<Uint8Array>({
        cancel() {
            firstBodyCancelled = true
        },
    }), { status: 401 })
    const secondResponse = new Response("still unauthorized", { status: 401 })
    const requests: Request[] = []
    const codexFetch = createOpenAiCodexFetch({
        credentials: provider,
        fetch: fetchImplementation(async (input, init) => {
            requests.push(new Request(input, init))
            return requests.length === 1 ? firstResponse : secondResponse
        }),
    })
    const controller = new AbortController()
    const payload = JSON.stringify({ input: "hello" })

    const response = await codexFetch(OPENAI_CODEX_RESPONSES_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
        signal: controller.signal,
    })

    expect(response).toBe(secondResponse)
    expect(requests).toHaveLength(2)
    expect(firstBodyCancelled).toBe(true)
    expect(firstResponse.bodyUsed).toBe(true)
    expect(secondResponse.bodyUsed).toBe(false)
    expect(provider.requireSignals).toEqual([controller.signal])
    expect(provider.refreshCalls).toEqual([{
        observedAccessToken: "old-access-token",
        observedAccountId: "old-account-id",
        signal: controller.signal,
    }])
    expect(requests[0]?.headers.get("authorization"))
        .toBe("Bearer old-access-token")
    expect(requests[0]?.headers.get("chatgpt-account-id"))
        .toBe("old-account-id")
    expect(requests[1]?.headers.get("authorization"))
        .toBe("Bearer new-access-token")
    expect(requests[1]?.headers.get("chatgpt-account-id"))
        .toBe("old-account-id")
    expect(requests[0]?.signal).not.toBeUndefined()
    expect(requests[1]?.signal).not.toBeUndefined()
    expect(await requests[0]?.text()).toBe(payload)
    expect(await requests[1]?.text()).toBe(payload)
})

test("does not refresh or retry 403, 429, or server errors", async () => {
    const provider = new StubCredentialProvider(
        credential("access-token", "account-id"),
    )
    const statuses = [403, 429, 503]
    let networkCalls = 0
    const codexFetch = createOpenAiCodexFetch({
        credentials: provider,
        fetch: fetchImplementation(async () => {
            const status = statuses[networkCalls]
            networkCalls += 1
            if (status === undefined) throw new Error("Unexpected retry")
            return new Response("error", { status })
        }),
    })

    for (const status of statuses) {
        const response = await codexFetch(
            OPENAI_CODEX_RESPONSES_URL,
            jsonPost(),
        )
        expect(response.status).toBe(status)
    }

    expect(networkCalls).toBe(statuses.length)
    expect(provider.refreshCalls).toHaveLength(0)
})

test("rejects empty access tokens and missing account IDs before fetch", async () => {
    const invalidCredentials = [
        credential("", "account-id"),
        credential("access-token", undefined),
        credential("access-token", "   "),
    ]
    let networkCalls = 0

    for (const invalidCredential of invalidCredentials) {
        const codexFetch = createOpenAiCodexFetch({
            credentials: new StubCredentialProvider(invalidCredential),
            fetch: fetchImplementation(async () => {
                networkCalls += 1
                return new Response("unexpected")
            }),
        })
        await expect(codexFetch(
            OPENAI_CODEX_RESPONSES_URL,
            jsonPost(),
        )).rejects.toThrow("OpenAI OAuth credential")
    }

    expect(networkCalls).toBe(0)
})

interface IFetchCall {
    readonly input: RequestInfo | URL
    readonly init: RequestInit | undefined
}

interface IRefreshCall {
    readonly observedAccessToken: string
    readonly observedAccountId: string
    readonly signal: AbortSignal | undefined
}

class StubCredentialProvider implements IOpenAiCodexCredentialProvider {
    readonly requireSignals: Array<AbortSignal | undefined> = []
    readonly refreshCalls: IRefreshCall[] = []
    readonly requiredCredential: IOAuthCredential
    readonly refreshedCredential: IOAuthCredential

    constructor(
        requiredCredential: IOAuthCredential,
        refreshedCredential: IOAuthCredential = requiredCredential,
    ) {
        this.requiredCredential = requiredCredential
        this.refreshedCredential = refreshedCredential
    }

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

function credential(
    access: string,
    accountId: string | undefined,
): IOAuthCredential {
    return {
        type: "oauth",
        access,
        refresh: "refresh-token",
        expires: 1_000,
        ...(accountId === undefined ? {} : { accountId }),
    }
}

function jsonPost(): RequestInit {
    return {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
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
