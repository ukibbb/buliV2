import { expect, test } from "bun:test"
import { AgentSession } from "@/sessions/agent-session"
import { SQLiteSessionManager } from "@/sessions/sqlite/sqlite-session-manager"

test("configuration cannot change while compaction is pending", async () => {
    const manager = new SQLiteSessionManager({ databasePath: ":memory:" })
    manager.createSession({ id: "session", agentId: "agent", title: "Test", createdAt: 1, updatedAt: 1 })
    const session = new AgentSession({
        agentId: "agent",
        sessionId: "session",
        manager,
        systemPrompt: "Base",
        tools: [],
        resolveRunConfiguration: () => ({
            reasoningEffort: "medium",
            model: {
                async *stream() {
                    yield { type: "finish", reason: "stop" }
                },
            },
        }),
    })
    try {
        await session.prompt("Question").runFinished
        const compaction = session.compact()
        try {
            expect(() => session.updateConfiguration({ systemPrompt: "New", tools: [] }))
                .toThrow("compacting")
            expect(session.state.systemPrompt).toBe("Base")
        } finally {
            await compaction
        }
    } finally {
        await session.dispose()
    }
})
