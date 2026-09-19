import { expect, test } from "bun:test"
import type { IAgentModelRequest } from "@/agent"
import { DeepSeekAgentModel } from "./deepseek-agent-model"

for (const modelId of ["deepseek-flash", "deepseek-v4-pro"] as const) {
    for (const reasoningEffort of ["low", "high", "max"] as const) {
        test(`adapter prepares ${modelId}/${reasoningEffort} for the common runner`, async () => {
            const bodies: unknown[] = []
            const model = new DeepSeekAgentModel({ modelId, auth: { authenticatedFetch: Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
                const request = new Request(input, init)
                expect(request.url).toBe("https://api.deepseek.com/chat/completions")
                bodies.push(await request.json())
                return new Response('data: {"id":"s","object":"chat.completion.chunk","created":1,"model":"deepseek-flash","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } })
            }, { preconnect: () => undefined }) } })
            const request: IAgentModelRequest = { sessionId: "s", runId: "r", systemPrompt: "System", messages: [{ id: "u", sessionId: "s", runId: "r", createdAt: 1, role: "user", source: "prompt", content: "Hello" }], tools: [], reasoningEffort, signal: new AbortController().signal, contextSummary: "checkpoint" }
            const events = await Array.fromAsync(model.stream(request))
            expect(events.at(-1)).toMatchObject({ type: "finish", reason: "stop" })
            expect(bodies).toHaveLength(1)
            expect(bodies[0]).toMatchObject({ model: modelId, reasoning_effort: reasoningEffort, thinking: { type: "enabled" }, messages: [{ role: "system", content: "System" }, { role: "user", content: expect.stringContaining("checkpoint") }, { role: "user", content: "Hello" }] })
        })
    }
}
