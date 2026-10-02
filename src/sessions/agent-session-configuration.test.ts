import { expect, spyOn, test } from "bun:test"
import { defineAgentTool, ToolAccess, type IAgentModelRequest } from "@/agent"
import { AgentSession } from "@/sessions/agent-session"
import { SQLiteSessionManager } from "@/sessions/sqlite/sqlite-session-manager"
import { estimateContextUsage } from "@/sessions/compaction/context-budget"

function createFixture() {
    const manager = new SQLiteSessionManager({ databasePath: ":memory:" })
    manager.createSession({ id: "session", agentId: "agent", title: "Test", createdAt: 1, updatedAt: 1 })
    const requests: IAgentModelRequest[] = []
    const session = new AgentSession({
        agentId: "agent",
        sessionId: "session",
        manager,
        systemPrompt: "Base",
        tools: [],
        resolveRunConfiguration: () => ({
            reasoningEffort: "medium",
            model: {
                async *stream(request) {
                    requests.push(request)
                    yield { type: "finish", reason: "stop" }
                },
            },
        }),
    })
    return { session, manager, requests }
}

const readTool = defineAgentTool({
    name: "read_note",
    description: "Read a note",
    inputSchema: { type: "object", additionalProperties: false },
    access: ToolAccess.ReadOnly,
    async execute() { return "note" },
})
const writeTool = defineAgentTool({
    name: "write_note",
    description: "Write a note",
    inputSchema: { type: "object", additionalProperties: false },
    access: ToolAccess.MayMutate,
    async execute() { return "saved" },
})

test("configuration updates preserve history, refresh telemetry and reach the model", async () => {
    const { session, manager, requests } = createFixture()
    try {
        await session.prompt("First question").runFinished
        const history = session.loadHistoryPage("main").messages
        const durableHistory = manager.loadRequiredContext("session").messages
        let publications = 0
        session.subscribe(() => { publications += 1 })
        const tools = [readTool]
        session.updateConfiguration({ systemPrompt: "Base with notes", tools })
        tools.length = 0
        expect(session.loadHistoryPage("main").messages).toEqual(history)
        expect(manager.loadRequiredContext("session").messages).toEqual(durableHistory)
        expect(session.state.tools).toEqual([readTool])
        expect(publications).toBe(1)
        expect(session.getSnapshot().contextUsage).toEqual(estimateContextUsage({
            systemPrompt: "Base with notes", tools: [readTool], messages: durableHistory,
        }))
        await session.prompt("Second question").runFinished
        expect(requests.at(-1)?.systemPrompt).toBe("Base with notes")
        expect(requests.at(-1)?.tools.map((tool) => tool.name)).toEqual([readTool.name])
        const updatedHistory = session.loadHistoryPage("main").messages
        session.updateConfiguration({ systemPrompt: "Base", tools: [] })
        expect(session.loadHistoryPage("main").messages).toEqual(updatedHistory)
        expect(session.state.tools).toEqual([])
        expect(session.state.systemPrompt).toBe("Base")
    } finally {
        await session.dispose()
    }
})

test("updated configuration preserves branch policy and restores full tools on return", async () => {
    const { session } = createFixture()
    try {
        session.createBranch()
        session.updateConfiguration({ systemPrompt: "Notes", tools: [readTool, writeTool] })
        expect(session.state.tools).toEqual([readTool])
        session.returnToParentBranch()
        expect(session.state.tools).toEqual([readTool, writeTool])
        expect(session.state.systemPrompt).toBe("Notes")
    } finally {
        await session.dispose()
    }
})

test("duplicate names reject the entire configuration before changing state", async () => {
    const { session } = createFixture()
    try {
        const state = session.state
        const snapshot = session.getSnapshot()
        expect(() => session.updateConfiguration({
            systemPrompt: "Invalid", tools: [readTool, readTool],
        })).toThrow("Duplicate tool name")
        expect(session.state).toBe(state)
        expect(session.getSnapshot()).toBe(snapshot)
    } finally {
        await session.dispose()
    }
})

test("configuration uses the live branch without a storage read", async () => {
    const { session, manager } = createFixture()
    const side = session.createBranch()
    let publications = 0
    session.subscribe(() => { publications += 1 })
    const read = spyOn(manager, "getActiveBranchId").mockImplementation(() => {
        throw new Error("Unexpected branch read")
    })
    try {
        session.updateConfiguration({ systemPrompt: "Notes", tools: [readTool, writeTool] })
        expect(read).not.toHaveBeenCalled()
        expect(publications).toBe(1)
        expect(session.getSnapshot().activeBranchId).toBe(side)
        expect(session.state.tools).toEqual([readTool])
        expect(session.state.systemPrompt).toBe("Notes")
        expect(session.getSnapshot().contextUsage).toEqual(estimateContextUsage({
            systemPrompt: "Notes", tools: [readTool], messages: [],
        }))
    } finally {
        read.mockRestore()
        await session.dispose()
        manager.dispose()
    }
})

test("observer failure does not reject a committed configuration or skip other observers", async () => {
    const { session } = createFixture()
    const failure = new Error("Observer failed")
    const log = spyOn(console, "error").mockImplementation(() => {})
    const unsubscribe = session.subscribe(() => { throw failure })
    let publications = 0
    session.subscribe(() => {
        publications += 1
        expect(session.state.systemPrompt).toBe("Notes")
        expect(session.state.tools).toEqual([readTool])
    })
    try {
        expect(() => session.updateConfiguration({
            systemPrompt: "Notes", tools: [readTool],
        })).not.toThrow()
        expect(publications).toBe(1)
        expect(log).toHaveBeenCalledTimes(1)
        expect(log).toHaveBeenCalledWith("Session observer failed", failure)
        expect(session.getSnapshot().contextUsage).toEqual(estimateContextUsage({
            systemPrompt: "Notes", tools: [readTool], messages: [],
        }))
    } finally {
        unsubscribe()
        log.mockRestore()
        await session.dispose()
    }
})

test("configuration updates reject active runs and disposed sessions", async () => {
    const { session } = createFixture()
    const configuration = { systemPrompt: "New", tools: [] }
    try {
        const run = session.prompt("Question")
        expect(() => session.updateConfiguration(configuration)).toThrow("running")
        await run.runFinished
        session.updateConfiguration(configuration)
    } finally {
        await session.dispose()
    }
    expect(() => session.updateConfiguration(configuration)).toThrow("disposed")
})
