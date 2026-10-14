import { expect, test } from "bun:test"
import { createDeepSeek } from "@ai-sdk/deepseek"
import type { IAgentModelRequest } from "@/agent"
import { streamAiSdkTurn, type IAiSdkPreparedTurn } from "./ai-sdk-agent-model"

const request: IAgentModelRequest = {
    sessionId: "s", runId: "r", systemPrompt: "system", messages: [], reasoningEffort: "high",
    signal: new AbortController().signal,
    tools: [{ name: "inspect", description: "test", inputSchema: { type: "object", properties: {} } }],
}
const call = { tool_calls: [{ index: 0, id: "c", type: "function", function: { name: "inspect", arguments: "{}" } }] }
function fixture(deltas: Record<string, unknown>[], finish = "stop", policy: IAiSdkPreparedTurn["toolCallReasoning"] = { mode: "not-required" }) {
    let count = 0
    const chunks = [...deltas.map(delta => ({ choices: [{ index: 0, delta, finish_reason: null }] })), {
        choices: [{ index: 0, delta: {}, finish_reason: finish }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 0, completion_tokens_details: { reasoning_tokens: 0 } },
    }]
    const model = createDeepSeek({ apiKey: "synthetic", fetch: Object.assign(async () => {
        count++
        return new Response(chunks.map(chunk => `data: ${JSON.stringify({ id: "s", object: "chat.completion.chunk", created: 1, model: "deepseek-flash", ...chunk })}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
    }, { preconnect: () => undefined }) })("deepseek-flash")
    const prepared: IAiSdkPreparedTurn = { model, messages: [{ role: "user", content: "test" }], toolCallReasoning: policy, normalizeError: () => new Error("sanitized") }
    return { collect: (input = request) => Array.fromAsync(streamAiSdkTurn(input, prepared)), count: () => count }
}
function retryFixture(statuses: number[], maxRetries?: number) {
    let count = 0
    const model = createDeepSeek({ apiKey: "synthetic", fetch: Object.assign(async () => {
        const status = statuses[count++] ?? 503
        if (status !== 200) return new Response("synthetic failure", {
            status, headers: { "retry-after-ms": "0" },
        })
        const chunk = {
            id: "s", object: "chat.completion.chunk", created: 1, model: "deepseek-flash",
            choices: [{ index: 0, delta: { content: "Recovered" }, finish_reason: "stop" }],
        }
        return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
            headers: { "content-type": "text/event-stream" },
        })
    }, { preconnect: () => undefined }) })("deepseek-flash")
    const prepared: IAiSdkPreparedTurn = {
        model, messages: [{ role: "user", content: "test" }],
        toolCallReasoning: { mode: "not-required" }, normalizeError: error => error,
        ...(maxRetries === undefined ? {} : { maxRetries }),
    }
    return {
        collect: () => Array.fromAsync(streamAiSdkTurn(request, prepared)),
        count: () => count,
    }
}

test("three SDK retries recover a transient HTTP failure", async () => {
    const f = retryFixture([503, 503, 503, 200], 3)
    const events = await f.collect()
    expect(f.count()).toBe(4)
    expect(events).toContainEqual(expect.objectContaining({ type: "text-delta", delta: "Recovered" }))
    expect(events.at(-1)).toMatchObject({ type: "finish", reason: "stop" })
})

test("three SDK retries stop after four failed attempts", async () => {
    const f = retryFixture([503, 503, 503, 503], 3)
    const events = await f.collect()
    expect(f.count()).toBe(4)
    expect(events.at(-1)).toMatchObject({ type: "error" })
})

test("SDK retries do not repeat a non-retryable HTTP failure", async () => {
    const f = retryFixture([400, 200], 3)
    const events = await f.collect()
    expect(f.count()).toBe(1)
    expect(events.at(-1)).toMatchObject({ type: "error" })
})

test("unspecified retry policy still makes only one attempt", async () => {
    const f = retryFixture([503, 200])
    const events = await f.collect()
    expect(f.count()).toBe(1)
    expect(events.at(-1)).toMatchObject({ type: "error" })
})

test("maps text, reasoning and zero usage without retries", async () => {
    const f = fixture([{ reasoning_content: "think" }, { content: "answer" }])
    const events = await f.collect()
    expect(events).toContainEqual(expect.objectContaining({ type: "text-delta", delta: "answer" }))
    expect(events).toContainEqual(expect.objectContaining({ type: "reasoning-delta", delta: "think" }))
    expect(events.at(-1)).toMatchObject({ type: "finish", reason: "stop", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 } })
    expect(f.count()).toBe(1)
})
test("releases calls only immediately before a valid terminal event", async () => {
    const events = await fixture([call], "tool_calls").collect()
    expect(events.slice(-2)).toMatchObject([{ type: "tool-call", toolCallId: "c", input: {} }, { type: "finish", reason: "tool-calls" }])
})
test("length discards calls", async () => {
    const events = await fixture([call], "length").collect()
    expect(events.some(e => e.type === "tool-call")).toBe(false)
    expect(events.at(-1)).toMatchObject({ type: "finish", reason: "length" })
})
test("explicit reasoning exception explains why calls are refused", async () => {
    const events = await fixture([call], "tool_calls", { mode: "require-nonempty", reason: "Original reasoning is needed for replay" }).collect()
    expect(events.some(e => e.type === "tool-call")).toBe(false)
    expect(events.at(-1)).toEqual({ type: "error", error: new Error("Original reasoning is needed for replay") })
})
test("pre-abort and duplicate descriptors prevent HTTP", async () => {
    const f = fixture([])
    await expect(f.collect({ ...request, signal: AbortSignal.abort(new Error("cancelled")) })).rejects.toThrow("cancelled")
    await expect(f.collect({ ...request, tools: [...request.tools, ...request.tools] })).rejects.toThrow("Duplicate tool name")
    expect(f.count()).toBe(0)
})
test("unexpected finish cannot release buffered calls", async () => {
    await expect(fixture([call], "stop").collect()).rejects.toThrow("sanitized")
})
