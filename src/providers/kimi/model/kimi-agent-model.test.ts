import { expect, test } from "bun:test"
import { Type } from "typebox"
import { defineAgentTool, runAgentLoop, isModelContextOverflowError, type IAgentModelRequest, type TAgentMessage, type TAgentModelEvent, type IUserMessage } from "@/agent"
import { createKimiFetch } from "../transport/kimi-fetch"
import { KimiAgentModel, type TKimiModelId } from "./kimi-agent-model"

const profile = { providerId: "kimi-coding", modelId: "k3" }
const user: IUserMessage = { id: "u", sessionId: "s", runId: "r", createdAt: 1, role: "user", source: "prompt", content: "Inspect" }
function response(deltas: Record<string, unknown>[], finish = "stop"): Response {
    const chunks = [...deltas.map((delta) => ({ choices: [{ index: 0, delta, finish_reason: null }] })), {
        choices: [{ index: 0, delta: {}, finish_reason: finish }],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30, prompt_tokens_details: { cached_tokens: 5 }, completion_tokens_details: { reasoning_tokens: 3 } },
    }].map((chunk) => ({ id: "synthetic", object: "chat.completion.chunk", created: 1, model: "k3", ...chunk }))
    return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
}
function fixture(reply: (call: number) => Response, modelId: TKimiModelId = "k3") {
    const bodies: unknown[] = []
    let reads = 0
    const fetcher = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        expect(request.url).toBe("https://api.kimi.com/coding/v1/chat/completions")
        expect(request.headers.get("authorization")).toBe("Bearer synthetic-key")
        bodies.push(await request.json())
        return reply(bodies.length)
    }, { preconnect: globalThis.fetch.preconnect })
    const model = new KimiAgentModel({ modelId, auth: { authenticatedFetch: createKimiFetch({
        fetch: fetcher, signal: new AbortController().signal,
        requireApiKey: async () => { reads++; return "synthetic-key" }, trackBody: () => {},
    }) } })
    return { model, bodies, keyReads: () => reads }
}
function request(overrides: Partial<IAgentModelRequest> = {}): IAgentModelRequest {
    return { sessionId: "s", runId: "r", systemPrompt: "System", messages: [user], tools: [], reasoningEffort: "high", signal: new AbortController().signal, ...overrides }
}
async function collect(model: KimiAgentModel, input = request()): Promise<TAgentModelEvent[]> {
    return Array.fromAsync(model.stream(input))
}
const calls = { tool_calls: [
    { index: 0, id: "call-1", type: "function", function: { name: "inspect", arguments: '{"path":"ok"}' } },
    { index: 1, id: "call-2", type: "function", function: { name: "inspect", arguments: '{"path":"fail"}' } },
] }

for (const reasoning of ["actual reasoning", ""]) {
    test(`agent-owned tool loop preserves reasoning and pairs, reasoning=${Boolean(reasoning)}`, async () => {
        const { model, bodies } = fixture((call) => call === 1
            ? response([{ reasoning_content: reasoning }, calls], "tool_calls")
            : response([{ content: "done" }]))
        const executed: string[] = []
        const inspect = defineAgentTool({ name: "inspect", description: "Synthetic", inputSchema: Type.Object({ path: Type.String() }), async execute(input) {
            executed.push(input.path)
            if (input.path === "fail") throw new Error("synthetic tool failure")
            return "synthetic result"
        } })
        const result = await runAgentLoop(user, { systemPrompt: "System", messages: [], tools: [inspect] }, {
            sessionId: "s", runId: "r", model, modelProfile: profile, reasoningEffort: "high",
            signal: new AbortController().signal, emit: () => {},
        })
        if (!reasoning) {
            expect(executed).toEqual([])
            expect(bodies).toHaveLength(1)
            expect(result.messages.at(-1)).toMatchObject({ stopReason: "error", errorMessage: expect.stringContaining("without nonempty reasoning") })
            return
        }
        expect(executed).toEqual(["ok", "fail"])
        expect(bodies).toHaveLength(2)
        expect(result.reason).toBe("completed")
        expect(bodies[1]).toMatchObject({ messages: [
            { role: "system", content: "System" }, { role: "user", content: "Inspect" },
            { role: "assistant", reasoning_content: reasoning, tool_calls: [{ id: "call-1" }, { id: "call-2" }] },
            { role: "tool", tool_call_id: "call-1", content: "synthetic result" },
            { role: "tool", tool_call_id: "call-2", content: expect.stringContaining("synthetic tool failure") },
        ] })
        expect(result.messages.find((message) => message.role === "assistant")).toMatchObject({
            model: profile, content: expect.arrayContaining([{ type: "reasoning", text: reasoning }]),
        })
    })
}

for (const modelId of ["k3", "k3-256k", "kimi-for-coding"] as const) {
    for (const effort of ["low", "high", "max"] as const) {
        test(`explicit model and effort ${modelId}/${effort}`, async () => {
            const { model, bodies } = fixture(() => response([{ content: "ok" }]), modelId)
            const events = await collect(model, request({ reasoningEffort: effort }))
            expect(bodies[0]).toMatchObject({ model: modelId, thinking: { type: "enabled" }, reasoning_effort: effort })
            expect(events.at(-1)).toMatchObject({ type: "finish", reason: "stop", usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30, cacheReadTokens: 5, reasoningTokens: 3 } })
        })
    }
}
for (const model of [undefined, { providerId: "openai", modelId: "k3" }, { providerId: "kimi-coding", modelId: "k3-256k" }]) {
    test(`rejects untrusted history ${JSON.stringify(model)} before credentials`, async () => {
        const f = fixture(() => response([]))
        const assistant: TAgentMessage = { id: "a", sessionId: "s", runId: "old", createdAt: 0, role: "assistant", stopReason: "stop", content: [{ type: "text", text: "old" }], ...(model ? { model } : {}) }
        await expect(collect(f.model, request({ messages: [assistant, user] }))).rejects.toThrow("same provider and model")
        expect(f.bodies).toHaveLength(0)
        expect(f.keyReads()).toBe(0)
    })
}
for (const effort of ["none", "minimal", "medium", "xhigh"] as const) {
    test(`rejects unsupported effort ${effort} before credentials`, async () => {
        const f = fixture(() => response([]))
        await expect(collect(f.model, request({ reasoningEffort: effort }))).rejects.toThrow("low, high and max")
        expect(f.keyReads()).toBe(0)
    })
}
for (const status of [400, 401, 413, 429]) {
    test(`HTTP ${status} is sanitized and never triggers overflow retry`, async () => {
        const f = fixture(() => Response.json({ error: { message: "synthetic-secret-response", type: "test" } }, { status }))
        const events = await collect(f.model)
        const error = events.find((event) => event.type === "error")
        expect(error?.type).toBe("error")
        if (error?.type !== "error") throw new Error("Expected error")
        expect(String(error.error)).toContain(`HTTP ${status}`)
        expect(String(error.error)).not.toContain("synthetic-secret-response")
        expect(isModelContextOverflowError(error.error)).toBe(false)
        expect(f.bodies).toHaveLength(1)
    })
}
test("output limit does not release tool calls", async () => {
    const f = fixture(() => response([{ reasoning_content: "actual" }, calls], "length"))
    const events = await collect(f.model, request({ tools: [{ name: "inspect", description: "Synthetic", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }] }))
    expect(events.some((event) => event.type === "tool-call")).toBe(false)
    expect(events.at(-1)).toMatchObject({ type: "finish", reason: "length" })
})
test("images are inline bytes and context summary remains assistant context", async () => {
    const f = fixture(() => response([{ content: "ok" }]))
    await collect(f.model, request({ contextSummary: "checkpoint", messages: [{ ...user, attachments: [{ type: "image", mimeType: "image/png", filename: "synthetic.png", data: "c3ludGhldGlj", source: { value: "image", start: 0, end: 5 } }] }] }))
    expect(f.bodies[0]).toMatchObject({ messages: [
        { role: "system", content: "System" },
        { role: "assistant", content: "Cumulative operational checkpoint:\ncheckpoint" },
        { role: "user", content: [{ type: "text", text: "Inspect" }, { type: "image_url", image_url: { url: "data:image/png;base64,c3ludGhldGlj" } }] },
    ] })
})
test("abort during streaming cancels upstream and emits no tool calls", async () => {
    const entered = Promise.withResolvers<void>()
    const waiting = Promise.withResolvers<void>()
    const controller = new AbortController()
    let cancelled = false
    const f = fixture(() => new Response(new ReadableStream<Uint8Array>({
        pull() { entered.resolve(); return waiting.promise },
        cancel() { cancelled = true; waiting.resolve() },
    }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } }))
    const events: TAgentModelEvent[] = []
    const pending = (async () => {
        for await (const event of f.model.stream(request({ signal: controller.signal }))) events.push(event)
    })().then(() => undefined, (error: unknown) => error)
    await entered.promise
    const reason = new Error("synthetic abort")
    controller.abort(reason)
    const outcome = await pending
    expect(outcome === reason || events.some((event) => event.type === "abort")).toBe(true)
    expect(events.some((event) => event.type === "tool-call")).toBe(false)
    expect(cancelled).toBe(true)
})

for (const kind of ["missing-reasoning", "missing-result", "orphan-result"] as const) {
    test(`rejects unsafe tool history: ${kind}`, async () => {
        const f = fixture(() => response([]))
        const assistant: TAgentMessage = {
            id: "a", sessionId: "s", runId: "old", createdAt: 0, role: "assistant", model: profile, stopReason: "tool-calls",
            content: [
                ...(kind === "missing-reasoning" ? [] : [{ type: "reasoning" as const, text: "actual" }]),
                { type: "toolCall", toolCallId: "call", toolName: "inspect", input: {} },
            ],
        }
        const result: TAgentMessage = { id: "t", sessionId: "s", runId: "old", createdAt: 0, role: "toolResult", toolCallId: "call", toolName: "inspect", content: "result", isError: false }
        const messages = kind === "orphan-result" ? [result] : kind === "missing-result" ? [assistant] : [assistant, result]
        await expect(collect(f.model, request({ messages }))).rejects.toThrow()
        expect(f.keyReads()).toBe(0)
    })
}

test("pre-abort prevents credential access", async () => {
    const f = fixture(() => response([]))
    const controller = new AbortController()
    controller.abort(new Error("cancelled"))
    await expect(collect(f.model, request({ signal: controller.signal }))).rejects.toThrow("cancelled")
    expect(f.keyReads()).toBe(0)
})
