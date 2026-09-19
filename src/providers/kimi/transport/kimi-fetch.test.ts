import { expect, test } from "bun:test"
import { createKimiFetch } from "./kimi-fetch"

const URL = "https://api.kimi.com/coding/v1/models"
const CHAT_URL = "https://api.kimi.com/coding/v1/chat/completions"
function mockFetch(run: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): typeof fetch {
    return Object.assign(run, { preconnect: globalThis.fetch.preconnect })
}

for (const [url, method] of [
    ["https://example.test/coding/v1/models", "GET"],
    ["http://api.kimi.com/coding/v1/models", "GET"],
    [URL + "?key=x", "GET"], [URL + "#fragment", "GET"],
    [URL + "/", "GET"], [URL, "POST"],
    [CHAT_URL, "GET"], [CHAT_URL, "PUT"],
    [CHAT_URL + "?key=x", "POST"], [CHAT_URL + "#fragment", "POST"],
    [CHAT_URL + "/", "POST"],
    ["https://example.test/coding/v1/chat/completions", "POST"],
    ["http://api.kimi.com/coding/v1/chat/completions", "POST"],
    ["https://api.kimi.com/coding/v1/messages", "POST"],
]) {
    test(`rejects unapproved request ${method} ${url} before reading credentials`, async () => {
        let touched = false
        const transport = createKimiFetch({
            signal: new AbortController().signal,
            requireApiKey: async () => { touched = true; return "secret" },
            fetch: mockFetch(async () => { touched = true; return new Response() }),
            trackBody: () => {},
        })
        await expect(transport(url!, { method: method! })).rejects.toThrow("not allowed")
        expect(touched).toBe(false)
    })
}

for (const endpoint of [URL, CHAT_URL]) {
test(`uses current credentials, replaces caller headers, forbids redirects and cookies: ${endpoint}`, async () => {
    let key = "first-synthetic-key"
    const requests: Request[] = []
    const credentials: Array<RequestCredentials | undefined> = []
    const transport = createKimiFetch({
        signal: new AbortController().signal,
        requireApiKey: async () => key,
        fetch: mockFetch(async (input, init) => {
            credentials.push(init?.credentials)
            requests.push(new Request(input, init))
            return new Response(null, { status: 204 })
        }),
        trackBody: () => {},
    })
    const init = endpoint === CHAT_URL ? { method: "POST", body: "{}" } : {}
    await transport(endpoint, { ...init, headers: { authorization: "wrong", "x-api-key": "wrong", cookie: "wrong", "user-agent": "other-client" } })
    key = "second-synthetic-key"
    await transport(endpoint, init)
    expect(requests.map((r) => r.headers.get("authorization"))).toEqual([
        "Bearer first-synthetic-key", "Bearer second-synthetic-key",
    ])
    expect(credentials).toEqual(["omit", "omit"])
    for (const request of requests) {
        expect(request.headers.get("x-api-key")).toBeNull()
        expect(request.headers.get("cookie")).toBeNull()
        expect(request.headers.get("user-agent")).toBe("buli/0.9.2")
        expect(request.redirect).toBe("error")
        expect(request.headers.get("accept")).toBe(endpoint === CHAT_URL ? "application/json, text/event-stream" : "application/json")
        if (endpoint === CHAT_URL) expect(request.headers.get("content-type")).toBe("application/json")
    }
})
}

for (const endpoint of [URL, CHAT_URL]) {
for (const status of [400, 401, 403, 413, 429]) {
    test(`returns HTTP ${status} without retry: ${endpoint}`, async () => {
        let calls = 0
        const transport = createKimiFetch({
            signal: new AbortController().signal,
            requireApiKey: async () => "synthetic-key",
            fetch: mockFetch(async () => { calls++; return new Response("error", { status }) }),
            trackBody: () => {},
        })
        const response = await transport(endpoint, endpoint === CHAT_URL ? { method: "POST", body: "{}" } : {})
        expect(response.status).toBe(status)
        await response.body?.cancel()
        expect(calls).toBe(1)
    })
}

}

for (const body of [undefined, "", "{", "null", "[]", "1", '"synthetic-secret"']) {
    test(`rejects invalid chat JSON before credentials: ${String(body)}`, async () => {
        let touched = false
        const transport = createKimiFetch({
            signal: new AbortController().signal,
            requireApiKey: async () => { touched = true; return "synthetic-key" },
            fetch: mockFetch(async () => { touched = true; return new Response() }),
            trackBody: () => {},
        })
        await expect(transport(CHAT_URL, { method: "POST", ...(body === undefined ? {} : { body }) }))
            .rejects.toThrow("Invalid Kimi JSON request body")
        expect(touched).toBe(false)
    })
}

test("preserves original chat JSON including whitespace, reasoning and image data", async () => {
    const body = ' { "messages": [{"role":"assistant","reasoning_content":"zażółć 🐈"}, {"role":"user","content":[{"type":"image_url","image_url":{"url":"data:image/png;base64,c3ludGhldGlj"}}]}] }\n'
    let sent: string | undefined
    const transport = createKimiFetch({
        signal: new AbortController().signal,
        requireApiKey: async () => "synthetic-key",
        fetch: mockFetch(async (input, init) => {
            sent = await new Request(input, init).text()
            return new Response(null, { status: 204 })
        }),
        trackBody: () => {},
    })
    await transport(CHAT_URL, { method: "POST", body })
    expect(sent).toBe(body)
})

for (const abortSource of ["caller", "lifetime"] as const) {
    test(`cancels pending chat body read before credentials: ${abortSource}`, async () => {
        const caller = new AbortController()
        const lifetime = new AbortController()
        const entered = Promise.withResolvers<void>()
        const waiting = Promise.withResolvers<void>()
        let cancelled = false
        let touched = false
        const body = new ReadableStream<Uint8Array>({
            pull() { entered.resolve(); return waiting.promise },
            cancel() { cancelled = true; waiting.resolve() },
        }, { highWaterMark: 0 })
        const transport = createKimiFetch({
            signal: lifetime.signal,
            requireApiKey: async () => { touched = true; return "synthetic-key" },
            fetch: mockFetch(async () => { touched = true; return new Response() }),
            trackBody: () => {},
        })
        const reason = new Error("Synthetic cancellation")
        const pending = transport(CHAT_URL, { method: "POST", body, signal: caller.signal })
            .then(() => undefined, (error: unknown) => error)
        await entered.promise
        const controller = abortSource === "caller" ? caller : lifetime
        controller.abort(reason)
        expect(await pending).toBe(reason)
        expect(cancelled).toBe(true)
        expect(touched).toBe(false)
    })
}

test("does not forward secret-bearing fetch errors", async () => {
    const transport = createKimiFetch({
        signal: new AbortController().signal,
        requireApiKey: async () => "synthetic-key",
        fetch: mockFetch(async () => { throw new Error("Bearer synthetic-key") }),
        trackBody: () => {},
    })
    const error = await transport(URL).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).not.toContain("synthetic-key")
    expect(error instanceof Error && error.cause).toBeUndefined()
})

for (const endpoint of [URL, CHAT_URL]) {
test(`rejects redirects even when an injected fetch ignores redirect policy: ${endpoint}`, async () => {
    let cancelled = false
    const transport = createKimiFetch({
        signal: new AbortController().signal,
        requireApiKey: async () => "synthetic-key",
        fetch: mockFetch(async () => new Response(new ReadableStream({ cancel() { cancelled = true } }), {
            status: 302, headers: { location: "https://example.test" },
        })),
        trackBody: () => {},
    })
    await expect(transport(endpoint, endpoint === CHAT_URL ? { method: "POST", body: "{}" } : {})).rejects.toThrow("Kimi authenticated request failed")
    expect(cancelled).toBe(true)
})
}

test("body lifecycle handles EOF, read failures and consumer cancellation", async () => {
    for (const mode of ["eof", "error", "cancel"] as const) {
        let completion: Promise<void> | undefined
        const transport = createKimiFetch({
            signal: new AbortController().signal,
            requireApiKey: async () => "synthetic-key",
            fetch: mockFetch(async () => new Response(new ReadableStream<Uint8Array>({
                pull(controller) {
                    if (mode === "error") controller.error(new Error("synthetic-key"))
                    else if (mode === "eof") {
                        controller.enqueue(new TextEncoder().encode("ok"))
                        controller.close()
                    }
                },
            }))),
            trackBody: (promise) => { completion = promise },
        })
        const response = await transport(URL)
        if (mode === "eof") expect(await response.text()).toBe("ok")
        if (mode === "error") await expect(response.text()).rejects.toThrow("Kimi response stream failed")
        if (mode === "cancel") await response.body?.cancel()
        expect(completion).toBeDefined()
        await completion
    }
})
