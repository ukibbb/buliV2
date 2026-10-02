import { expect, spyOn, test } from "bun:test"
import { defineAgentTool, type IAgentModel } from "@/agent"
import { AgentSession, SQLiteSessionManager } from "@/sessions"
import * as budget from "@/sessions/compaction/context-budget"

test("a deferred model refresh calculates final telemetry once with the new configuration", async () => {
    const manager = new SQLiteSessionManager({ databasePath: ":memory:" })
    manager.createSession({ id: "refresh", agentId: "agent", title: "Refresh", createdAt: 1, updatedAt: 1 })
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let contextWindowTokens = 100_000
    const session = new AgentSession({
        agentId: "agent", sessionId: "refresh", manager, systemPrompt: "System", tools: [],
        resolveRunConfiguration: () => ({
            reasoningEffort: "medium",
            modelProfile: { providerId: "test", modelId: "model", contextWindowTokens },
            model: { async *stream() {
                started.resolve()
                await release.promise
                yield { type: "finish", reason: "stop", usage: { inputTokens: 100 } }
            } },
        }),
    })
    const estimate = spyOn(budget, "estimateContextUsage")
    try {
        const run = session.prompt("Question")
        await started.promise
        contextWindowTokens = 200_000
        session.refreshContextUsage()
        session.refreshContextUsage()
        expect(estimate).toHaveBeenCalledTimes(1)
        expect(session.getSnapshot().contextUsage?.contextWindowTokens).toBe(100_000)
        release.resolve()
        await run.runFinished
        expect(estimate).toHaveBeenCalledTimes(2)
        expect(session.getSnapshot().contextUsage?.contextWindowTokens).toBe(200_000)
    } finally {
        release.resolve()
        await session.waitForIdle()
        estimate.mockRestore()
        await session.dispose()
        manager.dispose()
    }
})

for (const outcome of ["completed", "error", "aborted", "internal-error", "tool-abort"] as const) {
    test(`context telemetry is calculated at request boundaries and settlement: ${outcome}`, async () => {
        const manager = new SQLiteSessionManager({ databasePath: ":memory:" })
        manager.createSession({ id: "usage", agentId: "agent", title: "Usage", createdAt: 1, updatedAt: 1 })
        let requests = 0
        let executions = 0
        const tool = defineAgentTool({
            name: "probe", description: "Return a small result",
            inputSchema: { type: "object", additionalProperties: false },
            async execute() {
                executions += 1
                if (outcome === "tool-abort" && executions === 4) void session.abort()
                return "Result"
            },
        })
        const model: IAgentModel = {
            async *stream() {
                requests += 1
                expect(estimate.mock.calls.length).toBe(requests)
                if (requests === 1) {
                    for (let index = 0; index < 10; index += 1) {
                        yield { type: "tool-call", toolCallId: `call-${index}`, toolName: tool.name, input: {} }
                    }
                    yield { type: "finish", reason: "tool-calls", usage: { inputTokens: 100 } }
                    return
                }
                if (outcome === "error") {
                    yield { type: "error", error: new Error("Provider failed") }
                } else if (outcome === "aborted") {
                    yield { type: "abort", reason: "Cancelled" }
                } else {
                    yield { type: "text-delta", id: "answer", delta: "Done" }
                    yield { type: "finish", reason: "stop", usage: { inputTokens: 200 } }
                }
            },
        }
        const session = new AgentSession({
            agentId: "agent", sessionId: "usage", manager, systemPrompt: "System", tools: [tool],
            resolveRunConfiguration: () => ({ model, reasoningEffort: "medium" }),
        })
        const originalEstimate = budget.estimateContextUsage
        const estimate = spyOn(budget, "estimateContextUsage")
        const append = manager.appendMessage
        const appendSpy = spyOn(manager, "appendMessage").mockImplementation((message) => {
            if (outcome === "internal-error" && message.role === "toolResult" && executions === 4) {
                throw new Error("Persistence failed")
            }
            return append(message)
        })
        let historyNotifications = 0
        session.subscribeHistory(() => { historyNotifications += 1 })
        try {
            const run = session.prompt("Use tools")
            if (outcome === "internal-error") {
                await expect(run.runFinished).rejects.toThrow("Persistence failed")
                expect(requests).toBe(1)
                expect(executions).toBe(4)
                expect(estimate).toHaveBeenCalledTimes(2)
                expect(() => session.prompt("Retry")).toThrow("Session persistence failed")
            } else if (outcome === "tool-abort") {
                await run.runFinished
                expect(requests).toBe(1)
                expect(executions).toBe(4)
                expect(estimate).toHaveBeenCalledTimes(2)
            } else {
                await run.runFinished
                expect(requests).toBe(2)
                expect(executions).toBe(10)
                expect(estimate).toHaveBeenCalledTimes(3)
                expect(historyNotifications).toBe(13)
            }
            expect(session.getSnapshot().lastRunReason).toBe(outcome === "tool-abort" ? "aborted" : outcome)
            expect(session.getSnapshot().contextUsage).toEqual(originalEstimate({
                systemPrompt: "System", tools: [tool], messages: manager.loadRequiredContext("usage").messages,
            }))
        } finally {
            estimate.mockRestore()
            appendSpy.mockRestore()
            await session.dispose()
            manager.dispose()
        }
    })
}
