import { expect, test } from "bun:test"
import type { IAgentModel } from "@/agent"
import { AgentSession, InMemorySessionManager, type IAgentSessionRunConfiguration } from "@/sessions"

function seededManager(): InMemorySessionManager {
    const manager = new InMemorySessionManager()
    manager.createSession({ id: "session", agentId: "agent", title: "Test", createdAt: 1, updatedAt: 1 })
    manager.appendMessage({
        id: "answer", sessionId: "session", runId: "old", role: "assistant",
        content: [{ type: "reasoning", text: "R".repeat(20_000) }, { type: "text", text: "Done" }],
        stopReason: "stop", createdAt: 2,
    })
    return manager
}

for (const reasoningHistory of ["omit", "preserve"] as const) {
    test(`session telemetry and automatic compaction agree for ${reasoningHistory}`, async () => {
        const manager = seededManager()
        let summaries = 0
        let conversations = 0
        const model: IAgentModel = {
            async *stream(request) {
                if (request.runId.startsWith("compaction-")) {
                    summaries += 1
                    yield { type: "text-delta", id: "summary", delta: "Earlier work completed." }
                } else conversations += 1
                yield { type: "finish", reason: "stop" }
            },
        }
        const session = new AgentSession({
            agentId: "agent", sessionId: "session", manager, systemPrompt: "System", tools: [],
            resolveRunConfiguration: () => ({
                model, reasoningEffort: "high", estimationPolicy: { reasoningHistory },
                modelProfile: { providerId: "test", modelId: "model", contextWindowTokens: 16_000 },
            }),
        })
        try {
            expect(session.getSnapshot().contextUsage?.shouldCompact).toBe(reasoningHistory === "preserve")
            await session.prompt("Continue").runFinished
            expect(summaries).toBe(reasoningHistory === "preserve" ? 1 : 0)
            expect(conversations).toBe(1)
            expect(session.getSnapshot().contextUsage?.shouldCompact).toBe(false)
        } finally { await session.dispose() }
    })
}

test("active run captures policy; idle refresh replaces it and unavailable configuration clears it", async () => {
    const manager = seededManager()
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const policy: { reasoningHistory: "omit" | "preserve" } = { reasoningHistory: "preserve" }
    let available = true
    const configuration: IAgentSessionRunConfiguration = {
        model: { async *stream() {
            started.resolve()
            await release.promise
            yield { type: "finish", reason: "stop" }
        } },
        reasoningEffort: "high", estimationPolicy: policy,
    }
    const session = new AgentSession({
        agentId: "agent", sessionId: "session", manager, systemPrompt: "System", tools: [],
        resolveRunConfiguration: () => {
            if (!available) throw new Error("Unavailable")
            return configuration
        },
    })
    try {
        const run = session.prompt("Continue")
        await started.promise
        policy.reasoningHistory = "omit"
        release.resolve()
        await run.runFinished
        expect(session.getSnapshot().contextUsage!.estimatedInputTokens).toBeGreaterThan(10_000)
        session.refreshContextUsage()
        expect(session.getSnapshot().contextUsage!.estimatedInputTokens).toBeLessThan(1_000)
        policy.reasoningHistory = "preserve"
        session.refreshContextUsage()
        expect(session.getSnapshot().contextUsage!.estimatedInputTokens).toBeGreaterThan(10_000)
        available = false
        session.refreshContextUsage()
        expect(session.getSnapshot().contextUsage!.estimatedInputTokens).toBeLessThan(1_000)
    } finally {
        release.resolve()
        await session.dispose()
    }
})

test("manual compaction compares before and after using preserved reasoning", async () => {
    const manager = seededManager()
    const session = new AgentSession({
        agentId: "agent", sessionId: "session", manager, systemPrompt: "System", tools: [],
        resolveRunConfiguration: () => ({
            model: { async *stream() {
                yield { type: "text-delta", id: "summary", delta: "Summary ".repeat(100) }
                yield { type: "finish", reason: "stop" }
            } },
            reasoningEffort: "high", estimationPolicy: { reasoningHistory: "preserve" },
        }),
    })
    try {
        expect(await session.compact()).toBeDefined()
        expect(session.getSnapshot().contextUsage!.estimatedInputTokens).toBeLessThan(1_000)
    } finally { await session.dispose() }
})
