import { expect, test } from "bun:test"
import { createDeepSeek } from "@ai-sdk/deepseek"
import { createDeepSeekFetch } from "../transport/deepseek-fetch"
import { jsonSchema, streamText, type ModelMessage, type ToolSet } from "ai"

const tools = {
    inspect: {
        description: "Synthetic inspection",
        inputSchema: jsonSchema<{ path: string }>({
            type: "object", properties: { path: { type: "string" } },
            required: ["path"], additionalProperties: false,
        }),
    },
} satisfies ToolSet

function model(run: (request: Request) => Promise<Response>, id = "deepseek-flash") {
    return createDeepSeek({
        apiKey: "synthetic-not-a-real-key",
        baseURL: "https://api.deepseek.com",
        fetch: Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
            const request = new Request(input, init)
            expect(request.url).toBe("https://api.deepseek.com/chat/completions")
            expect(request.method).toBe("POST")
            expect(request.headers.get("authorization")).toBe("Bearer synthetic-not-a-real-key")
            return run(request)
        }, { preconnect: () => undefined }),
    })(id)
}

function sse(deltas: readonly Record<string, unknown>[], finish = "stop", usage?: Record<string, unknown>) {
    const base = { id: "synthetic", object: "chat.completion.chunk", created: 1, model: "deepseek-flash" }
    const chunks = [...deltas.map(delta => ({
        ...base, choices: [{ index: 0, delta, finish_reason: null }],
    })), {
        ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }], ...(usage ? { usage } : {}),
    }]
    return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
    })
}

for (const id of ["deepseek-flash", "deepseek-v4-pro"]) {
    for (const effort of ["low", "high", "max"]) {
        test(`${id} sends explicit thinking and ${effort} through ai streamText`, async () => {
            const result = streamText({
                model: model(async request => {
                    expect(await request.json()).toMatchObject({
                        model: id, thinking: { type: "enabled" }, reasoning_effort: effort,
                        stream: true, stream_options: { include_usage: true },
                    })
                    return sse([{ reasoning_content: "synthetic reasoning" }, { content: "ok" }])
                }, id),
                prompt: "Synthetic", maxRetries: 0,
                providerOptions: { deepseek: { thinking: { type: "enabled" }, reasoningEffort: effort } },
            })
            expect(await result.text).toBe("ok")
            expect(await result.reasoningText).toBe("synthetic reasoning")
        })
    }

    test(`${id} preserves reasoning across a tool round trip and a second user turn`, async () => {
        const bodies: unknown[] = []
        const backend = model(async request => {
            bodies.push(await request.json())
            if (bodies.length === 1) return sse([
                { reasoning_content: "inspect reasoning" },
                { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "inspect", arguments: '{"path":' } }] },
                { tool_calls: [{ index: 0, function: { arguments: '"fixture"}' } }] },
            ], "tool_calls")
            return sse([{ reasoning_content: "answer reasoning" }, { content: "done" }])
        }, id)
        const messages: ModelMessage[] = [{ role: "user", content: "Inspect fixture" }]
        const first = streamText({ model: backend, messages, tools, maxRetries: 0 })
        const calls = await first.toolCalls
        expect(calls).toHaveLength(1)
        expect(calls[0]).toMatchObject({ toolCallId: "call-1", toolName: "inspect", input: { path: "fixture" } })
        messages.push(...(await first.response).messages, {
            role: "tool", content: [{ type: "tool-result", toolCallId: "call-1", toolName: "inspect", output: { type: "text", value: "fixture result" } }],
        })
        const second = streamText({ model: backend, messages, tools, maxRetries: 0 })
        expect(await second.text).toBe("done")
        messages.push(...(await second.response).messages, { role: "user", content: "Next question" })
        const third = streamText({ model: backend, messages, tools, maxRetries: 0 })
        expect(await third.text).toBe("done")
        expect(bodies[2]).toMatchObject({ messages: [
            { role: "user", content: "Inspect fixture" },
            { role: "assistant", reasoning_content: "inspect reasoning", tool_calls: [{ id: "call-1", function: { name: "inspect", arguments: '{"path":"fixture"}' } }] },
            { role: "tool", tool_call_id: "call-1", content: "fixture result" },
            { role: "assistant", reasoning_content: "answer reasoning", content: "done" },
            { role: "user", content: "Next question" },
        ] })
    })
}

test("SDK fills missing V4 historical reasoning with an empty field, not recovered content", async () => {
    const result = streamText({
        model: model(async request => {
            expect(await request.json()).toMatchObject({ messages: [
                { role: "user", content: "First" },
                { role: "assistant", content: "Old answer", reasoning_content: "" },
                { role: "user", content: "Next" },
            ] })
            return sse([{ content: "ok" }])
        }),
        messages: [{ role: "user", content: "First" }, { role: "assistant", content: "Old answer" }, { role: "user", content: "Next" }],
        tools, maxRetries: 0,
    })
    expect(await result.text).toBe("ok")
})

for (const total of [0, 20]) {
    test(`SDK exposes usage without double counting cached tokens (${total})`, async () => {
        const result = streamText({
            model: model(async () => sse([{ content: "ok" }], "stop", {
                prompt_tokens: total, completion_tokens: 8, total_tokens: total + 8,
                prompt_cache_hit_tokens: total / 2, prompt_cache_miss_tokens: total / 2,
                completion_tokens_details: { reasoning_tokens: 3 },
            })), prompt: "Synthetic", maxRetries: 0,
        })
        await result.text
        expect(await result.usage).toMatchObject({
            inputTokens: total, outputTokens: 8, totalTokens: total + 8,
            inputTokenDetails: { cacheReadTokens: total / 2 },
            outputTokenDetails: { reasoningTokens: 3 },
        })
    })
}

for (const status of [400, 401, 429, 503]) {
    test(`HTTP ${status} is surfaced without retry`, async () => {
        let requests = 0
        const result = streamText({
            model: model(async () => {
                requests++
                return Response.json({ error: { message: "synthetic rejection", type: "test_error" } }, { status })
            }), prompt: "Synthetic", maxRetries: 0, onError: () => {},
        })
        await expect(result.text).rejects.toThrow()
        expect(requests).toBe(1)
    })
}

test("in-stream provider errors are observable and do not produce tool calls", async () => {
    const result = streamText({
        model: model(async () => new Response('data: {"error":{"message":"synthetic failure","type":"server_error"}}\n\ndata: [DONE]\n\n', {
            headers: { "content-type": "text/event-stream" },
        })), prompt: "Synthetic", tools, maxRetries: 0, onError: () => {},
    })
    const types: string[] = []
    for await (const part of result.fullStream) types.push(part.type)
    expect(types).toContain("error")
    expect(types).not.toContain("tool-call")
})

test("cancellation reaches the injected fetch", async () => {
    const entered = Promise.withResolvers<void>()
    const controller = new AbortController()
    let cancelled = false
    const result = streamText({
        model: model(async request => {
            entered.resolve()
            await new Promise<void>((_, reject) => {
                const abort = () => { cancelled = true; reject(new DOMException("Cancelled", "AbortError")) }
                if (request.signal.aborted) abort()
                else request.signal.addEventListener("abort", abort, { once: true })
            })
            throw new Error("Unreachable")
        }), prompt: "Synthetic", maxRetries: 0, abortSignal: controller.signal, onError: () => {},
    })
    const consumed = result.consumeStream()
    await entered.promise
    controller.abort()
    await consumed
    expect(cancelled).toBe(true)
})

test("SDK uses fresh transport-owned keys and preserves reasoning through protected fetch", async () => {
    let key = "first-synthetic-key"
    const keys: Array<string | null> = []
    const completions: Promise<void>[] = []
    const transport = createDeepSeekFetch({
        signal: new AbortController().signal,
        requireApiKey: async () => key,
        trackBody: completion => { completions.push(completion) },
        fetch: Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
            const request = new Request(input, init)
            expect(request.url).toBe("https://api.deepseek.com/chat/completions")
            expect(request.redirect).toBe("error")
            expect(init?.credentials).toBe("omit")
            expect(request.headers.get("cookie")).toBeNull()
            expect(request.headers.get("x-api-key")).toBeNull()
            keys.push(request.headers.get("authorization"))
            expect(await request.json()).toMatchObject({
                model: "deepseek-flash", thinking: { type: "enabled" }, reasoning_effort: "high",
                messages: [
                    { role: "user", content: "First" },
                    { role: "assistant", content: "Answer", reasoning_content: "original reasoning" },
                    { role: "user", content: "Next" },
                ],
            })
            return sse([{ reasoning_content: "new reasoning" }, { content: "ok" }])
        }, { preconnect: () => undefined }),
    })
    const backend = createDeepSeek({ apiKey: "transport-owned-placeholder", baseURL: "https://api.deepseek.com", fetch: transport })("deepseek-flash")
    for (const next of ["first-synthetic-key", "second-synthetic-key"]) {
        key = next
        const result = streamText({
            model: backend, maxRetries: 0, tools,
            messages: [
                { role: "user", content: "First" },
                { role: "assistant", content: [{ type: "reasoning", text: "original reasoning" }, { type: "text", text: "Answer" }] },
                { role: "user", content: "Next" },
            ],
            providerOptions: { deepseek: { thinking: { type: "enabled" }, reasoningEffort: "high" } },
            headers: { cookie: "wrong", "x-api-key": "wrong" },
        })
        expect(await result.text).toBe("ok")
        expect(await result.reasoningText).toBe("new reasoning")
    }
    expect(keys).toEqual(["Bearer first-synthetic-key", "Bearer second-synthetic-key"])
    expect(completions).toHaveLength(2)
    await Promise.all(completions)
})

test("SDK cancellation through protected fetch releases its pending response body", async () => {
    const entered = Promise.withResolvers<void>()
    const controller = new AbortController()
    let cancelled = false
    let completion: Promise<void> | undefined
    const transport = createDeepSeekFetch({
        signal: new AbortController().signal,
        requireApiKey: async () => "synthetic-key",
        trackBody: value => { completion = value },
        fetch: Object.assign(async () => new Response(new ReadableStream<Uint8Array>({
            pull() { entered.resolve() },
            cancel() { cancelled = true },
        }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } }), { preconnect: () => undefined }),
    })
    const result = streamText({
        model: createDeepSeek({ apiKey: "placeholder", fetch: transport })("deepseek-flash"),
        prompt: "Synthetic", maxRetries: 0, abortSignal: controller.signal, onError: () => {},
    })
    const consumed = result.consumeStream()
    await entered.promise
    controller.abort()
    await consumed
    expect(completion).toBeDefined()
    await completion
    expect(cancelled).toBe(true)
})
