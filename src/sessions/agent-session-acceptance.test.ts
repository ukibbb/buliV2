import { expect, spyOn, test } from "bun:test"
import { Type } from "typebox"
import { defineAgentTool, type IAgentModel, type TAgentMessage } from "@/agent"
import { AgentSession, SQLiteSessionManager } from "@/sessions"

const info = { id: "acceptance", agentId: "buli", title: "Acceptance", createdAt: 1, updatedAt: 1 }

function options(manager: SQLiteSessionManager, model: IAgentModel) {
    return { agentId: info.agentId, sessionId: info.id, manager, systemPrompt: "System",
        resolveRunConfiguration: () => ({ model, reasoningEffort: "medium" as const }), tools: [] }
}

for (const role of ["user", "assistant", "toolResult"] as const) {
    for (const failure of [new Error("Immutable acceptance failed"), undefined]) {
        test(`a real postcommit clone failure blocks Session execution: ${role}, ${String(failure)}`, async () => {
            const manager = new SQLiteSessionManager({ databasePath: ":memory:" })
            manager.createSession(info)
            let providerCalls = 0
            const executed: string[] = []
            const model: IAgentModel = { async *stream() {
                providerCalls++
                yield { type: "tool-call", toolCallId: "first", toolName: "probe", input: {} }
                yield { type: "tool-call", toolCallId: "second", toolName: "probe", input: {} }
                yield { type: "finish", reason: "tool_calls" }
            } }
            const session = new AgentSession({ ...options(manager, model), tools: [defineAgentTool({
                name: "probe", description: "Test acceptance boundaries", inputSchema: Type.Object({}), access: "read-only",
                execute: async (_input, context) => { executed.push(context.toolCallId); return "Saved result" },
            })] })
            let committedId: string | undefined
            let armed = false
            const append = manager.appendMessage
            const appendSpy = spyOn(manager, "appendMessage").mockImplementation((message) => {
                const result = append(message)
                if (message.role === role) { committedId = message.id; armed = true }
                return result
            })
            const clone = globalThis.structuredClone
            const cloneSpy = spyOn(globalThis, "structuredClone").mockImplementation((value, transfer) => {
                if (armed && value && typeof value === "object" && "id" in value && value.id === committedId) {
                    armed = false
                    throw failure
                }
                return clone(value, transfer)
            })
            try {
                const run = session.prompt("Persist before accepting")
                const acknowledgement = run.initialPromptProcessed.then(() => ({ rejected: false }), (cause: unknown) => ({ rejected: true, cause }))
                const finished = run.runFinished.then(() => ({ rejected: false, cause: undefined }), (cause: unknown) => ({ rejected: true, cause }))
                expect(await finished).toEqual({ rejected: true, cause: failure })
                expect((await acknowledgement).rejected).toBe(role === "user")
                expect(providerCalls).toBe(role === "user" ? 0 : 1)
                expect(executed).toEqual(role === "toolResult" ? ["first"] : [])
                expect(session.loadHistoryPage("main").messages.some((message) => message.id === committedId)).toBe(true)
                expect(manager.deleteEmptySession(info.id)).toBe(false)
                expect(() => session.prompt("Must stay blocked")).toThrow("Session persistence failed")
                expect(() => session.compact()).toThrow("Session persistence failed")
            } finally {
                cloneSpy.mockRestore()
                appendSpy.mockRestore()
                await session.dispose()
                manager.dispose()
            }
        })
    }
}

for (const stage of ["reload", "freeze"] as const) {
    for (const failure of [new Error("Checkpoint acceptance failed"), undefined]) {
        test(`checkpoint survives failed post-save ${stage}: ${String(failure)}`, async () => {
            const manager = new SQLiteSessionManager({ databasePath: ":memory:" })
            manager.createSession(info)
            const messages: TAgentMessage[] = [
                { id: "u", sessionId: info.id, runId: "seed", role: "user", source: "prompt", content: "X".repeat(8_000), createdAt: 2 },
                { id: "a", sessionId: info.id, runId: "seed", role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Y".repeat(8_000) }], createdAt: 3 },
            ]
            for (const message of messages) manager.appendMessage(message)
            const model: IAgentModel = { async *stream() {
                yield { type: "text-delta", id: "summary", delta: "Complete short summary" }
                yield { type: "finish", reason: "stop" }
            } }
            const session = new AgentSession({ ...options(manager, model), generateId: () => "saved-cp" })
            let saved = false
            const save = manager.saveCompactionCheckpoint
            const saveSpy = spyOn(manager, "saveCompactionCheckpoint").mockImplementation((checkpoint) => {
                save(checkpoint)
                saved = true
            })
            const read = manager.loadRequiredContext
            const readSpy = spyOn(manager, "loadRequiredContext").mockImplementation((id) => {
                if (saved && stage === "reload") throw failure
                return read(id)
            })
            const freeze = Object.freeze
            const freezeSpy = spyOn(Object, "freeze").mockImplementation(<T>(value: T): Readonly<T> => {
                if (saved && stage === "freeze" && value && typeof value === "object" && "id" in value && value.id === "saved-cp") throw failure
                return freeze(value)
            })
            try {
                const result = await session.compact().then(() => ({ rejected: false, cause: undefined }), (cause: unknown) => ({ rejected: true, cause }))
                expect(result).toEqual({ rejected: true, cause: failure })
                expect(saved).toBe(true)
                expect(manager.getCompactionCheckpoint(info.id)?.summary).toBe("Complete short summary")
                expect(session.loadHistoryPage("main").messages).toEqual(messages)
                expect(() => session.prompt("Must not dispatch")).toThrow("Session persistence failed")
                expect(() => session.compact()).toThrow("Session persistence failed")
            } finally {
                freezeSpy.mockRestore()
                readSpy.mockRestore()
                saveSpy.mockRestore()
                await session.dispose()
            }
            try {
                const reopened = new AgentSession(options(manager, model))
                try {
                    expect(manager.loadRequiredContext(info.id)).toMatchObject({ messages: [], contextSummary: "Complete short summary" })
                    expect(reopened.getSnapshot().isRunning).toBe(false)
                } finally { await reopened.dispose() }
            } finally { manager.dispose() }
        })
    }
}

test("reopening and returning to a branch restores only the latest error metadata", async () => {
    const manager = new SQLiteSessionManager({ databasePath: ":memory:" })
    manager.createSession(info)
    manager.appendMessage({ id: "failed", sessionId: info.id, runId: "failed-run", role: "assistant", createdAt: 2,
        stopReason: "error", errorMessage: "Provider unavailable", content: [{ type: "text", text: "Partial response" }] })
    const model: IAgentModel = { async *stream() { yield { type: "finish", reason: "stop" } } }
    const session = new AgentSession(options(manager, model))
    try {
        expect(session.getSnapshot().assistantError).toEqual({ id: "failed", runId: "failed-run", errorMessage: "Provider unavailable" })
        session.createBranch()
        const run = session.prompt("Retry in the side branch")
        await run.initialPromptProcessed
        expect(session.getSnapshot().assistantError).toBeUndefined()
        await run.runFinished
        session.returnToParentBranch()
        expect(session.getSnapshot().assistantError).toEqual({ id: "failed", runId: "failed-run", errorMessage: "Provider unavailable" })
        expect(session.loadHistoryPage("main").messages.map((message) => message.id)).toEqual(["failed"])
        await session.prompt("Retry in the parent branch").runFinished
        expect(session.getSnapshot().assistantError).toBeUndefined()
    } finally { await session.dispose(); manager.dispose() }
})
