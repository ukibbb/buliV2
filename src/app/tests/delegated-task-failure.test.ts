import { expect, test } from "bun:test"
import { DelegatedTasks } from "@/app/delegated-tasks"
import { SQLiteSessionManager } from "@/sessions"
import type { IAgentModel } from "@/agent"

function fixture() {
    const manager = new SQLiteSessionManager({ databasePath: ":memory:" })
    manager.createSession({ id: "parent", agentId: "buli", title: "Parent", createdAt: 1, updatedAt: 1 })
    manager.appendMessage({ id: "assistant", sessionId: "parent", runId: "run", role: "assistant", createdAt: 2,
        content: [{ type: "toolCall", toolCallId: "call", toolName: "delegate_task", input: {} }], stopReason: "tool-calls" })
    const service = new DelegatedTasks({ manager, explorer: { id: "explorer", name: "Explorer", systemPrompt: "explorer", tools: [] } })
    const controller = new AbortController()
    const context = { sessionId: "parent", assistantMessageId: "assistant", runId: "run", toolCallId: "call", signal: controller.signal }
    return { manager, service, controller, context }
}

test("one failed Explorer retains its position without cancelling its sibling", async () => {
    const { manager, service, context } = fixture()
    let calls = 0
    const model: IAgentModel = { async *stream() {
        if (calls++ === 0) { yield { type: "error", error: new Error("Research failed") }; return }
        yield { type: "text-start", id: "t" }
        yield { type: "text-delta", id: "t", delta: "Sibling report" }
        yield { type: "text-end", id: "t" }
        yield { type: "finish", reason: "stop" }
    } }
    try {
        const result = JSON.parse(await service.run([{ task: "first" }, { task: "second" }], context, { model, reasoningEffort: "medium" }))
        expect(result.results.map((task: { status: string }) => task.status)).toEqual(["failed", "completed"])
        expect(result.results[1].answer).toBe("Sibling report")
    } finally { await service.dispose(); manager.dispose() }
})

test("recovery marks unfinished children as interrupted and keeps their history accessible", async () => {
    const { manager, service } = fixture()
    manager.createDelegatedTask({ id: "child", agentId: "explorer", title: "Research", createdAt: 3, updatedAt: 3 }, {
        id: "task", parentSessionId: "parent", assistantMessageId: "assistant", toolCallId: "call", childSessionId: "child",
        position: 0, task: "Research", modelId: "test", reasoningEffort: "medium", status: "running", createdAt: 3,
    })
    try {
        manager.recoverInterruptedTools("parent")
        expect(service.list("parent", "assistant", "call")[0]?.status).toBe("interrupted")
        expect(service.open("child").getSnapshot().isRunning).toBe(false)
        expect(manager.listSessions().map((session) => session.id)).toEqual(["parent"])
    } finally { await service.dispose(); manager.dispose() }
})

test("parent cancellation stops all active Explorers and records cancelled states", async () => {
    const { manager, service, context, controller } = fixture()
    const started = Promise.withResolvers<void>()
    let calls = 0
    const model: IAgentModel = { async *stream(request) {
        if (++calls === 2) started.resolve()
        await new Promise<void>((resolve) => {
            if (request.signal.aborted) resolve()
            else request.signal.addEventListener("abort", () => resolve(), { once: true })
        })
        yield { type: "abort" }
    } }
    try {
        const pending = service.run([{ task: "first" }, { task: "second" }], context, { model, reasoningEffort: "medium" })
        await started.promise
        controller.abort()
        const result = JSON.parse(await pending)
        expect(result.results.map((task: { status: string }) => task.status)).toEqual(["cancelled", "cancelled"])
    } finally { await service.dispose(); manager.dispose() }
})
