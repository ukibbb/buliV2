import { expect, spyOn, test } from "bun:test"
import { defineAgentTool, ToolAccess, type IAgentModel, type IAgentModelRequest } from "@/agent"
import { AgentSession } from "@/sessions/agent-session"
import { InMemorySessionManager } from "@/sessions/in-memory-session-manager"

function fixture(model?: IAgentModel) {
    const manager = new InMemorySessionManager()
    manager.createSession({ id: "session", agentId: "agent", title: "Test", createdAt: 1, updatedAt: 1 })
    const requests: IAgentModelRequest[] = []
    const tools = [ToolAccess.ReadOnly, ToolAccess.MayMutate].map((access, index) => defineAgentTool({
        name: `tool_${index}`, description: "Tool", access,
        inputSchema: { type: "object" }, async execute() { return "done" },
    }))
    const options = {
        agentId: "agent", sessionId: "session", manager, systemPrompt: "System", tools,
        resolveRunConfiguration: () => ({
            reasoningEffort: "medium" as const,
            model: model ?? {
                async *stream(request: IAgentModelRequest) {
                    requests.push({ ...request, messages: structuredClone(request.messages) })
                    yield { type: "text-start" as const, id: "answer" }
                    yield { type: "text-delta" as const, id: "answer", delta: "Answer" }
                    yield { type: "text-end" as const, id: "answer" }
                    yield { type: "finish" as const, reason: "stop" as const }
                },
            },
        }),
    }
    return { manager, requests, tools, options, session: new AgentSession(options) }
}

test("live branch navigation restores parent history, checkpoint and tools without merging", async () => {
    const { session, manager, requests, tools } = fixture()
    try {
        await session.prompt("Parent message").runFinished
        const compactedMessages = manager.getMessages("session")
        await session.prompt("Recent parent message").runFinished
        const parentMessages = manager.getMessages("session")
        const checkpoint = {
            id: "parent-checkpoint", sessionId: "session", createdAt: 2, reason: "manual" as const,
            compactedMessageCount: compactedMessages.length,
            throughMessageId: compactedMessages.at(-1)!.id, summary: "Parent summary",
        }
        manager.saveCompactionCheckpoint(checkpoint)
        const side = session.createBranch()
        expect(manager.getActiveBranchId("session")).toBe(side)
        expect(session.state.tools).toEqual(tools.slice(0, 1))
        await session.prompt("Secret side message").runFinished
        const sideMessages = manager.getMessages("session")
        manager.saveCompactionCheckpoint({
            ...checkpoint, id: "side-checkpoint", summary: "Secret side summary",
            compactedMessageCount: sideMessages.length, throughMessageId: sideMessages.at(-1)!.id,
        })
        session.createBranch()
        session.returnToParentBranch()
        expect(manager.getActiveBranchId("session")).toBe(side)
        expect(session.state.tools).toEqual(tools.slice(0, 1))
        session.returnToParentBranch()
        expect(session.state.messages).toEqual(parentMessages)
        expect(session.getSnapshot().compactionCheckpoint).toEqual(checkpoint)
        expect(manager.getCompactionCheckpoint("session")).toEqual(checkpoint)
        expect(session.state.tools).toEqual(tools)
        await session.prompt("Continue parent").runFinished
        const request = requests.at(-1)!
        expect(request.contextSummary).toBe("Parent summary")
        expect(JSON.stringify(request.messages)).not.toContain("Secret side")
        expect(request.tools.map((tool) => tool.name)).toEqual(tools.map((tool) => tool.name))
    } finally { await session.dispose() }
})

for (const queue of ["steer", "followUp"] as const) {
    test(`navigation rejects running agents and retained ${queue} before storage changes`, async () => {
        const started = Promise.withResolvers<void>()
        const { session, manager } = fixture({
            async *stream(request) {
                started.resolve()
                await new Promise<void>((resolve) => {
                    if (request.signal.aborted) return resolve()
                    request.signal.addEventListener("abort", () => resolve(), { once: true })
                })
                yield { type: "abort", reason: "Stopped" }
            },
        })
        const create = spyOn(manager, "createBranch")
        try {
            const run = session.prompt("Question")
            await run.initialPromptProcessed
            await started.promise
            expect(() => session.createBranch()).toThrow("running")
            session[queue]("Keep queued input")
            await session.abort()
            await run.runFinished
            expect(() => session.createBranch()).toThrow("Restore queued messages")
            expect(create).not.toHaveBeenCalled()
            session.clearQueuedMessages()
            session.createBranch()
            expect(create).toHaveBeenCalledTimes(1)
        } finally { create.mockRestore(); await session.dispose() }
    })
}

for (const afterCommit of [false, true]) {
    test(`navigation failures block further work and reopening uses stored branch (committed: ${afterCommit})`, async () => {
        const { session, manager, options } = fixture()
        const originalCreate = manager.createBranch
        const create = spyOn(manager, "createBranch").mockImplementation((sessionId, branchId) => {
            if (afterCommit) originalCreate(sessionId, branchId)
            throw new Error("Storage failure")
        })
        try {
            expect(() => session.createBranch()).toThrow("Reopen the session")
            expect(() => session.prompt("No")).toThrow("Reopen the session")
            expect(() => session.compact()).toThrow("Reopen the session")
            expect(() => session.steer("No")).toThrow("Reopen the session")
            expect(() => session.followUp("No")).toThrow("Reopen the session")
            expect(() => session.returnToParentBranch()).toThrow("Reopen the session")
        } finally { create.mockRestore(); await session.dispose() }
        const reopened = new AgentSession(options)
        try {
            expect(reopened.state.tools).toHaveLength(afterCommit ? 1 : 2)
            await reopened.prompt("Resumed").runFinished
        } finally { await reopened.dispose() }
    })
}

test("read failure after persisted navigation blocks work until reopening", async () => {
    const { session, manager, options } = fixture()
    const read = spyOn(manager, "getMessages").mockImplementation(() => { throw new Error("Read failed") })
    try {
        expect(() => session.createBranch()).toThrow("Reopen the session")
        expect(manager.getActiveBranchId("session")).not.toBe("main")
        expect(() => session.prompt("No")).toThrow("Reopen the session")
    } finally { read.mockRestore(); await session.dispose() }
    const reopened = new AgentSession(options)
    try { expect(reopened.state.tools).toHaveLength(1) } finally { await reopened.dispose() }
})

test("navigation is blocked during compaction before touching storage", async () => {
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let compacting = false
    const { session, manager } = fixture({
        async *stream() {
            if (compacting) {
                started.resolve()
                await release.promise
            }
            yield { type: "text-start", id: "answer" }
            yield { type: "text-delta", id: "answer", delta: compacting ? "Short summary" : "Long answer ".repeat(100) }
            yield { type: "text-end", id: "answer" }
            yield { type: "finish", reason: "stop" }
        },
    })
    const create = spyOn(manager, "createBranch")
    try {
        await session.prompt("Question").runFinished
        compacting = true
        const task = session.compact()
        await started.promise
        expect(() => session.createBranch()).toThrow("compacting")
        expect(create).not.toHaveBeenCalled()
        release.resolve()
        await task
        session.createBranch()
        expect(create).toHaveBeenCalledTimes(1)
    } finally {
        release.resolve()
        create.mockRestore()
        await session.dispose()
    }
})

test("return from main is harmless and observer reentry is rejected", async () => {
    const { session, manager } = fixture()
    try {
        expect(() => session.returnToParentBranch()).toThrow("main branch")
        await session.prompt("Still usable").runFinished
        let rejected = 0
        const unsubscribe = session.subscribe(() => {
            expect(() => session.createBranch()).toThrow("switching branches")
            expect(() => session.prompt("Reentry")).toThrow("switching branches")
            rejected += 1
        })
        session.createBranch()
        unsubscribe()
        expect(rejected).toBe(1)
        expect(manager.getActiveBranchId("session")).not.toBe("main")
    } finally { await session.dispose() }
    expect(() => session.createBranch()).toThrow("disposed")
})
