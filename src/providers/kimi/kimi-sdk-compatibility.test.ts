import { expect, test } from "bun:test"
import { createMoonshotAI } from "@ai-sdk/moonshotai"
import { jsonSchema, streamText, type ModelMessage, type ToolSet } from "ai"
import { createKimiFetch } from "./transport/kimi-fetch"

const endpoint = "https://api.kimi.com/coding/v1/chat/completions"
const tools = {
    inspect: {
        description: "Synthetic inspection",
        inputSchema: jsonSchema<{ path: string }>({
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
            additionalProperties: false,
        }),
    },
} satisfies ToolSet

function sse(deltas: readonly Record<string, unknown>[], finish = "stop"): Response {
    const chunks = [...deltas.map((delta) => ({
        id: "synthetic", object: "chat.completion.chunk", created: 1, model: "k3",
        choices: [{ index: 0, delta, finish_reason: null }],
    })), {
        id: "synthetic", object: "chat.completion.chunk", created: 1, model: "k3",
        choices: [{ index: 0, delta: {}, finish_reason: finish }],
    }]
    return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
    })
}

function provider(fetchMock: typeof fetch) {
    return createMoonshotAI({
        apiKey: "synthetic-not-a-real-key",
        baseURL: "https://api.kimi.com/coding/v1",
        fetch: fetchMock,
    })
}

function mockFetch(run: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): typeof fetch {
    return Object.assign(run, { preconnect: globalThis.fetch.preconnect })
}

test("Moonshot SDK streams through Kimi transport with fresh transport-owned credentials", async () => {
    let key = "first-transport-synthetic-key"
    const requests: Request[] = []
    const bodies: unknown[] = []
    const completions: Promise<void>[] = []
    const transport = createKimiFetch({
        signal: new AbortController().signal,
        requireApiKey: async () => key,
        trackBody: (completion) => { completions.push(completion) },
        fetch: mockFetch(async (input, init) => {
            const request = new Request(input, init)
            requests.push(request)
            bodies.push(await request.json())
            expect(init?.credentials).toBe("omit")
            return sse([{ reasoning_content: "synthetic reasoning" }, { content: "ok" }])
        }),
    })
    const model = provider(transport)("k3")
    for (const nextKey of ["first-transport-synthetic-key", "second-transport-synthetic-key"]) {
        key = nextKey
        const result = streamText({
            model, prompt: "Synthetic prompt", maxRetries: 0,
            headers: { "x-api-key": "wrong", cookie: "wrong", "user-agent": "wrong" },
        })
        expect(await result.text).toBe("ok")
        expect(await result.reasoningText).toBe("synthetic reasoning")
    }
    expect(requests.map((request) => request.headers.get("authorization"))).toEqual([
        "Bearer first-transport-synthetic-key", "Bearer second-transport-synthetic-key",
    ])
    for (const request of requests) {
        expect(request.url).toBe(endpoint)
        expect(request.method).toBe("POST")
        expect(request.redirect).toBe("error")
        expect(request.headers.get("x-api-key")).toBeNull()
        expect(request.headers.get("cookie")).toBeNull()
        expect(request.headers.get("user-agent")).toBe("buli/0.9.2")
        expect(request.headers.get("content-type")).toBe("application/json")
    }
    for (const body of bodies) expect(body).toMatchObject({ model: "k3", stream: true })
    expect(completions).toHaveLength(2)
    await Promise.all(completions)
})

for (const status of [400, 401, 413, 429]) {
    test(`Moonshot SDK through Kimi transport does not retry HTTP ${status}`, async () => {
        let calls = 0
        let keyReads = 0
        const completions: Promise<void>[] = []
        const model = provider(createKimiFetch({
            signal: new AbortController().signal,
            requireApiKey: async () => { keyReads++; return "transport-synthetic-key" },
            trackBody: (completion) => { completions.push(completion) },
            fetch: mockFetch(async () => {
                calls++
                return Response.json({ error: { message: "synthetic rejection", type: "test_error" } }, { status })
            }),
        }))("k3")
        const result = streamText({ model, prompt: "Synthetic", maxRetries: 0, onError: () => {} })
        await expect(result.text).rejects.toThrow()
        expect(calls).toBe(1)
        expect(keyReads).toBe(1)
        expect(completions).toHaveLength(1)
        await Promise.all(completions)
    })
}

test("Moonshot SDK cancellation through Kimi transport releases the response body", async () => {
    const entered = Promise.withResolvers<void>()
    const controller = new AbortController()
    let cancelled = false
    let completion: Promise<void> | undefined
    let sentSignal: AbortSignal | null | undefined
    const model = provider(createKimiFetch({
        signal: new AbortController().signal,
        requireApiKey: async () => "transport-synthetic-key",
        trackBody: (value) => { completion = value },
        fetch: mockFetch(async (_input, init) => {
            sentSignal = init?.signal
            return new Response(new ReadableStream<Uint8Array>({
                pull() { entered.resolve() },
                cancel() { cancelled = true },
            }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } })
        }),
    }))("k3")
    const result = streamText({ model, prompt: "Synthetic", maxRetries: 0, abortSignal: controller.signal, onError: () => {} })
    const consumed = result.consumeStream()
    await entered.promise
    controller.abort()
    await consumed
    expect(sentSignal?.aborted).toBe(true)
    expect(completion).toBeDefined()
    await completion
    expect(cancelled).toBe(true)
})

for (const modelId of ["k3", "k3-256k", "kimi-for-coding", "kimi-for-coding-highspeed"]) {
    test(`Moonshot SDK retains Kimi Code ID and explicit options: ${modelId}`, async () => {
        let sent: unknown
        const model = provider(mockFetch(async (input, init) => {
            const request = new Request(input, init)
            expect(request.url).toBe(endpoint)
            expect(request.method).toBe("POST")
            sent = await request.json()
            return sse([{ content: "ok" }])
        }))(modelId)
        const result = streamText({
            model, prompt: "Synthetic prompt", maxRetries: 0,
            providerOptions: { moonshotai: {
                thinking: { type: "enabled" },
                ...(modelId === "kimi-for-coding-highspeed" ? {} : { reasoningEffort: "high" }),
            } },
        })
        expect(await result.text).toBe("ok")
        expect(sent).toMatchObject({ model: modelId, thinking: { type: "enabled" } })
        if (modelId !== "kimi-for-coding-highspeed") expect(sent).toMatchObject({ reasoning_effort: "high" })
    })
}

for (const reasoning of ["synthetic reasoning", ""]) {
    test(`Moonshot SDK tool round trip with ${reasoning ? "nonempty" : "empty"} reasoning`, async () => {
        const requests: unknown[] = []
        const model = provider(mockFetch(async (input, init) => {
            requests.push(await new Request(input, init).json())
            if (requests.length === 1) return sse([
                { reasoning_content: reasoning },
                { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "inspect", arguments: '{"path":' } }] },
                { tool_calls: [{ index: 0, function: { arguments: '"fixture"}' } }] },
            ], "tool_calls")
            return sse([{ content: "done" }])
        }))("k3")
        const first = streamText({ model, prompt: "Inspect fixture", tools, maxRetries: 0 })
        const calls = await first.toolCalls
        expect(calls).toHaveLength(1)
        expect(calls[0]?.input).toEqual({ path: "fixture" })
        const messages: ModelMessage[] = [
            { role: "user", content: "Inspect fixture" },
            ...(await first.response).messages,
            { role: "tool", content: [{ type: "tool-result", toolCallId: "call-1", toolName: "inspect", output: { type: "text", value: "fixture result" } }] },
        ]
        const second = streamText({ model, messages, tools, maxRetries: 0 })
        expect(await second.text).toBe("done")
        expect(requests[1]).toMatchObject({ messages: [
            { role: "user", content: "Inspect fixture" },
            { role: "assistant", ...(reasoning ? { reasoning_content: reasoning } : {}), tool_calls: [{ id: "call-1", function: { name: "inspect", arguments: '{"path":"fixture"}' } }] },
            { role: "tool", tool_call_id: "call-1", content: "fixture result" },
        ] })
        if (!reasoning) expect(JSON.stringify(requests[1])).not.toContain('"reasoning_content"')
    })
}

for (const status of [401, 429]) {
    test(`Moonshot SDK does not retry HTTP ${status} with maxRetries zero`, async () => {
        let calls = 0
        const model = provider(mockFetch(async () => {
            calls++
            return Response.json({ error: { message: "synthetic rejection", type: "test_error" } }, { status })
        }))("k3")
        const result = streamText({ model, prompt: "Synthetic", maxRetries: 0, onError: () => {} })
        await expect(result.text).rejects.toThrow()
        expect(calls).toBe(1)
    })
}

test("Moonshot SDK passes cancellation to the injected fetch", async () => {
    const entered = Promise.withResolvers<void>()
    let cancelled = false
    const controller = new AbortController()
    const model = provider(mockFetch(async (input, init) => {
        const request = new Request(input, init)
        entered.resolve()
        await new Promise<void>((_, reject) => {
            const abort = () => { cancelled = true; reject(new DOMException("Cancelled", "AbortError")) }
            if (request.signal.aborted) abort()
            else request.signal.addEventListener("abort", abort, { once: true })
        })
        throw new Error("Unreachable")
    }))("k3")
    const result = streamText({ model, prompt: "Synthetic", maxRetries: 0, abortSignal: controller.signal, onError: () => {} })
    const consumed = result.consumeStream()
    await entered.promise
    controller.abort()
    await consumed
    expect(cancelled).toBe(true)
})
