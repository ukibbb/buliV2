import { expect, mock, test } from "bun:test"
import { createKimiModelComposition } from "./create-kimi-model-composition"

test("Kimi composition is lazy, independent and registers preserve for every model", async () => {
    const bodies: unknown[] = []
    const transport = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        if (request.method === "GET") return Response.json({ data: [
            { id: "k3", context_length: 262144 }, { id: "k3-256k" }, { id: "kimi-for-coding" },
        ] })
        bodies.push(await request.json())
        return new Response('data: {"id":"synthetic","object":"chat.completion.chunk","created":1,"model":"synthetic","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
            headers: { "content-type": "text/event-stream" },
        })
    })
    const auth = { authenticatedFetch: Object.assign(transport, { preconnect: () => undefined }) }
    const composition = createKimiModelComposition({ auth })
    expect(transport).not.toHaveBeenCalled()
    expect(composition.additionalTools).toEqual([])
    expect(composition.models[0]?.estimationPolicy).toEqual({ reasoningHistory: "preserve" })
    expect(composition.models[0]?.modelProfile).not.toHaveProperty("contextWindowTokens")
    expect(composition.selection).toEqual({ modelId: "kimi-coding/kimi-for-coding", reasoningEffort: "max" })
    const models = await composition.discovery!.loadModels(new AbortController().signal)
    expect(models).toHaveLength(3)
    for (const entry of models) {
        expect(entry.id).toBe(`kimi-coding/${entry.modelProfile?.modelId}`)
        expect(entry.estimationPolicy).toEqual({ reasoningHistory: "preserve" })
        expect(entry.modelProfile?.providerId).toBe("kimi-coding")
        expect(entry).not.toHaveProperty("fallbackSelectionId")
        const events = await Array.fromAsync(entry.model.stream({
            sessionId: "s", runId: "r", systemPrompt: "Synthetic",
            messages: [{ id: "u", sessionId: "s", runId: "r", createdAt: 1, role: "user", source: "prompt", content: "Synthetic" }],
            tools: [],
            reasoningEffort: entry.defaultReasoningEffort, signal: new AbortController().signal,
        }))
        expect(events.at(-1)?.type).toBe("finish")
        expect(bodies.at(-1)).toMatchObject({ model: entry.modelProfile?.modelId, reasoning_effort: entry.defaultReasoningEffort })
    }
    expect(models[0]?.modelProfile?.contextWindowTokens).toBe(262144)
    expect(models[1]?.modelProfile).not.toHaveProperty("contextWindowTokens")
})

test("injected catalog receives cancellation and errors are not replaced with static models", async () => {
    const unexpected = Object.assign(async (): Promise<Response> => { throw new Error("Unexpected transport") }, { preconnect: () => undefined })
    const error = new Error("catalog unavailable")
    const load = mock(async (_signal?: AbortSignal): Promise<never> => { throw error })
    const composition = createKimiModelComposition({ auth: { authenticatedFetch: unexpected }, catalog: { load } })
    const signal = new AbortController().signal
    await expect(composition.discovery!.loadModels(signal)).rejects.toBe(error)
    expect(load).toHaveBeenCalledWith(signal)
})
