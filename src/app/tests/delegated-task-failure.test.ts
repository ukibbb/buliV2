import { expect, spyOn, test } from "bun:test"
import { DelegatedTasks } from "@/app/delegated-tasks"
import { SQLiteSessionManager } from "@/sessions"
import { defineAgentTool, type IAgentModel, type IRuntimeAgentTool } from "@/agent"

function fixture(tools: IRuntimeAgentTool[] = []) {
    const manager = new SQLiteSessionManager({ databasePath: ":memory:" })
    manager.createSession({ id: "parent", agentId: "buli", title: "Parent", createdAt: 1, updatedAt: 1 })
    manager.appendMessage({ id: "assistant", sessionId: "parent", runId: "run", role: "assistant", createdAt: 2,
        content: [{ type: "toolCall", toolCallId: "call", toolName: "delegate_task", input: {} }], stopReason: "tool-calls" })
    const service = new DelegatedTasks({ manager, agents: [{ id: "explorer", name: "Explorer", systemPrompt: "explorer", tools }] })
    const controller = new AbortController()
    const context = { sessionId: "parent", assistantMessageId: "assistant", runId: "run", toolCallId: "call", signal: controller.signal }
    return { manager, service, controller, context }
}

test("streaming does not publish task records and active tools use accepted context without SQLite reads", async () => {
    const toolStarted = Promise.withResolvers<void>()
    const releaseTool = Promise.withResolvers<void>()
    const releaseText = Promise.withResolvers<void>()
    const textPublished = Promise.withResolvers<void>()
    const tool = defineAgentTool({
        name: "probe", description: "Wait for test release", inputSchema: { type: "object" },
        async execute() { toolStarted.resolve(); await releaseTool.promise; return "Done" },
    })
    const { manager, service, context } = fixture([tool])
    const recentReads = spyOn(manager, "loadRecentConversation")
    const listReads = spyOn(manager, "loadDelegatedTasks")
    const statuses: string[] = []
    const unsubscribe = service.subscribe(() => {
        statuses.push(service.list("parent", "assistant", "call")[0]!.status)
    })
    let requests = 0
    const model: IAgentModel = { async *stream() {
        if (requests++ === 0) {
            yield { type: "tool-call", toolCallId: "probe-call", toolName: "probe", input: {} }
            yield { type: "finish", reason: "tool-calls" }
            return
        }
        yield { type: "text-start", id: "report" }
        yield { type: "text-delta", id: "report", delta: "Report" }
        textPublished.resolve()
        await releaseText.promise
        yield { type: "finish", reason: "stop" }
    } }
    const pending = service.run([{ agent: "explorer", task: "Research" }], context, { model, reasoningEffort: "medium" })
    try {
        await toolStarted.promise
        const task = service.list("parent", "assistant", "call")[0]!
        expect(service.currentTool(task.childSessionId)).toBe("probe")
        expect(recentReads).not.toHaveBeenCalled()
        expect(statuses).toEqual(["running"])
        const reads = listReads.mock.calls.length
        releaseTool.resolve()
        await textPublished.promise
        expect(service.currentTool(task.childSessionId)).toBeUndefined()
        expect(statuses).toEqual(["running"])
        expect(listReads).toHaveBeenCalledTimes(reads)
        releaseText.resolve()
        const result = JSON.parse(await pending)
        expect(result.results[0].answer).toBe("Report")
        expect(statuses).toEqual(["running", "completed"])
        expect(service.currentTool(task.childSessionId)).toBeUndefined()
    } finally {
        releaseTool.resolve()
        releaseText.resolve()
        await pending
        unsubscribe()
        recentReads.mockRestore()
        listReads.mockRestore()
        await service.dispose()
        manager.dispose()
    }
})

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
        const result = JSON.parse(await service.run([{ agent: "explorer", task: "first" }, { agent: "explorer", task: "second" }], context, { model, reasoningEffort: "medium" }))
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
        const pending = service.run([{ agent: "explorer", task: "first" }, { agent: "explorer", task: "second" }], context, { model, reasoningEffort: "medium" })
        await started.promise
        controller.abort()
        const result = JSON.parse(await pending)
        expect(result.results.map((task: { status: string }) => task.status)).toEqual(["cancelled", "cancelled"])
    } finally { await service.dispose(); manager.dispose() }
})
