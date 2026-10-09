import { expect, spyOn, test } from "bun:test"
import { BuliApplicationRuntime } from "@/app/runtime"
import { McpConnection } from "@/mcp/mcp-connection"
import { NOVIBE_READ_TOOL_NAMES } from "@/mcp/novibe"
import { SQLiteSessionManager } from "@/sessions"
import type { IAgentModelRequest } from "@/agent/model"

const locationToolNames = ["create_cabinet", "create_catalog", "create_category", "create_folder", "create_subfolder"]

function fixture(options: { missingTool?: boolean; instructions?: string; waitForList?: Promise<void> } = {}) {
    let initializations = 0
    const listStarted = Promise.withResolvers<void>()
    const server = Bun.serve({
        hostname: "127.0.0.1", port: 0,
        async fetch(request) {
            if (request.method !== "POST") return new Response(null, { status: 405 })
            const message = await request.json() as { id?: number; method: string }
            if (message.id === undefined) return new Response(null, { status: 202 })
            const respond = (result: unknown) => Response.json({ jsonrpc: "2.0", id: message.id, result })
            if (message.method === "initialize") {
                initializations++
                return respond({ protocolVersion: "2025-11-25", capabilities: { tools: {} },
                    serverInfo: { name: "test", version: "1" }, instructions: options.instructions ?? "Test NoVibe instructions" })
            }
            if (message.method === "tools/list") {
                listStarted.resolve()
                await options.waitForList
                const names = options.missingTool ? [] : [...NOVIBE_READ_TOOL_NAMES, "edit_document", "create_document", ...locationToolNames, "future_tool"]
                return respond({ tools: names.map((name) => ({ name, inputSchema: { type: "object" } })) })
            }
            return respond({ content: [{ type: "text", text: "Test note" }] })
        },
    })
    const connect = McpConnection.connect.bind(McpConnection)
    const closes: ReturnType<typeof spyOn<McpConnection, "close">>[] = []
    const connectSpy = spyOn(McpConnection, "connect").mockImplementation(async (options) => {
        const connection = await connect({ ...options, endpoint: new URL("/mcp/", server.url) })
        closes.push(spyOn(connection, "close"))
        return connection
    })
    const requests: IAgentModelRequest[] = []
    let id = 0
    const manager = new SQLiteSessionManager({ databasePath: ":memory:" })
    const runtime = new BuliApplicationRuntime({
        workspaceRoot: "/workspace", manager,
        agents: [
            { id: "test", name: "Test", systemPrompt: "Base", tools: [] },
            { id: "novibe", name: "NoVibe", systemPrompt: "Local tool instructions", tools: [] },
        ], defaultAgentId: "test",
        models: [{ id: "test", name: "Test", reasoningEfforts: ["medium"], defaultReasoningEffort: "medium",
            model: { async *stream(request) { requests.push(request); yield { type: "finish", reason: "stop" } } } }],
        selection: { modelId: "test", reasoningEffort: "medium" }, generateId: () => `session-${++id}`,
    })
    const first = runtime.createSession({ agentId: "test", title: "First" }).id
    const second = runtime.createSession({ agentId: "test", title: "Second" }).id
    return {
        runtime, manager, first, second, requests, closes, listStarted: listStarted.promise,
        initializations: () => initializations,
        async prompt(sessionId: string) { await runtime.submitPrompt({ sessionId, text: "Read" }).runFinished },
        async dispose() {
            try { await runtime.dispose() } finally { connectSpy.mockRestore(); await server.stop(true) }
        },
    }
}

test("NoVibe activation discovers all tools, is session-local and idempotent; off preserves history", async () => {
    const f = fixture()
    try {
        await f.runtime.activateNovibe(f.first)
        expect(await f.runtime.activateNovibe(f.first)).toContain("aktywne")
        expect(f.initializations()).toBe(1)
        expect(f.runtime.openSession(f.first).loadHistoryPage("main").messages).toHaveLength(0)
        await f.prompt(f.first)
        expect(f.requests.at(-1)?.tools.map((tool) => tool.name)).toEqual(
            [...NOVIBE_READ_TOOL_NAMES, "edit_document", "create_document", ...locationToolNames, "future_tool"].map((name) => `novibe__${name}`),
        )
        expect(f.requests.at(-1)?.systemPrompt).toContain("Test NoVibe instructions")
        expect(f.requests.at(-1)?.systemPrompt).not.toContain("Base")
        expect(f.runtime.listSessions().find(session => session.id === f.first)?.agentId).toBe("novibe")
        await f.prompt(f.second)
        expect(f.requests.at(-1)?.tools).toHaveLength(0)
        const history = f.runtime.openSession(f.first).loadHistoryPage("main").messages
        await f.runtime.deactivateNovibe(f.first)
        expect(f.runtime.openSession(f.first).loadHistoryPage("main").messages).toEqual(history)
        expect(f.closes[0]).toHaveBeenCalledTimes(1)
        expect(f.runtime.listSessions().find(session => session.id === f.first)?.agentId).toBe("test")
        await f.prompt(f.first)
        expect(f.requests.at(-1)?.tools).toHaveLength(0)
        expect(f.requests.at(-1)?.systemPrompt).toBe("Base")
    } finally { await f.dispose() }
})

test("an empty tool catalog does not require hardcoded NoVibe tools", async () => {
    const f = fixture({ missingTool: true })
    try {
        await f.runtime.activateNovibe(f.first)
        await f.prompt(f.first)
        expect(f.requests.at(-1)?.tools).toHaveLength(0)
        expect(f.requests.at(-1)?.systemPrompt).toContain("Test NoVibe instructions")
    } finally { await f.dispose() }
})

test("closing a session cancels pending activation and reopening stays inactive", async () => {
    const gate = Promise.withResolvers<void>()
    const f = fixture({ waitForList: gate.promise })
    try {
        const activation = f.runtime.activateNovibe(f.first)
        const rejected = activation.then(() => undefined, (error: unknown) => error)
        await f.listStarted
        await f.runtime.closeSession(f.first)
        expect(await rejected).toBeInstanceOf(Error)
        gate.resolve()
        await f.prompt(f.first)
        expect(f.requests.at(-1)?.tools).toHaveLength(0)
    } finally { gate.resolve(); await f.dispose() }
})

test("reopened NoVibe preserves history and blocks generation until reconnection", async () => {
    const f = fixture()
    try {
        await f.prompt(f.first)
        const source = f.runtime.openSession(f.first)
        const history = source.loadHistoryPage("main").messages
        await f.runtime.activateNovibe(f.first)
        expect(f.runtime.openSession(f.first)).toBe(source)
        expect(source.loadHistoryPage("main").messages).toEqual(history)
        await f.runtime.closeSession(f.first)
        expect(f.runtime.listSessions().find(session => session.id === f.first)?.agentId).toBe("novibe")
        expect(f.runtime.openSession(f.first).loadHistoryPage("main").messages).toEqual(history)
        const requests = f.requests.length
        await expect(f.prompt(f.first)).rejects.toThrow("wymaga połączenia")
        expect(f.requests).toHaveLength(requests)
        await f.runtime.activateNovibe(f.first)
        await f.prompt(f.first)
        expect(f.requests.at(-1)?.systemPrompt).not.toContain("Base")
    } finally { await f.dispose() }
})

test("empty server instructions leave the current agent unchanged and close transport", async () => {
    const f = fixture({ instructions: "  " })
    try {
        await expect(f.runtime.activateNovibe(f.first)).rejects.toThrow("instrukcji")
        expect(f.runtime.listSessions().find(session => session.id === f.first)?.agentId).toBe("test")
        expect(f.closes[0]).toHaveBeenCalledTimes(1)
        await f.prompt(f.first)
        expect(f.requests.at(-1)?.systemPrompt).toBe("Base")
    } finally { await f.dispose() }
})

test("off cancels an activation still waiting for tools", async () => {
    const gate = Promise.withResolvers<void>()
    const f = fixture({ waitForList: gate.promise })
    try {
        const activation = f.runtime.activateNovibe(f.first).catch(error => error)
        await f.listStarted
        await f.runtime.deactivateNovibe(f.first)
        expect(await activation).toBeInstanceOf(Error)
        gate.resolve()
        await f.prompt(f.first)
        expect(f.requests.at(-1)?.systemPrompt).toBe("Base")
    } finally { gate.resolve(); await f.dispose() }
})

test("failed agent persistence leaves configuration, identity and history unchanged", async () => {
    const f = fixture()
    const update = spyOn(f.manager, "updateSessionAgent").mockImplementation(() => { throw new Error("Storage unavailable") })
    try {
        await f.prompt(f.first)
        const history = f.runtime.openSession(f.first).loadHistoryPage("main").messages
        await expect(f.runtime.activateNovibe(f.first)).rejects.toThrow("Storage unavailable")
        expect(f.manager.getSessionInfo(f.first)?.agentId).toBe("test")
        expect(f.runtime.openSession(f.first).loadHistoryPage("main").messages).toEqual(history)
        expect(f.closes[0]).toHaveBeenCalledTimes(1)
        await f.prompt(f.first)
        expect(f.requests.at(-1)?.systemPrompt).toBe("Base")
    } finally { update.mockRestore(); await f.dispose() }
})

test("switching preserves branch identity and read-only policy", async () => {
    const f = fixture()
    try {
        await f.prompt(f.first)
        const branch = f.runtime.createBranch(f.first)
        await f.runtime.activateNovibe(f.first)
        expect(f.manager.getActiveBranchId(f.first)).toBe(branch)
        await f.prompt(f.first)
        expect(f.requests.at(-1)?.tools.map(tool => tool.name)).toEqual(NOVIBE_READ_TOOL_NAMES.map(name => `novibe__${name}`))
        await f.runtime.deactivateNovibe(f.first)
        expect(f.manager.getActiveBranchId(f.first)).toBe(branch)
        f.runtime.returnToParentBranch(f.first)
        await f.prompt(f.first)
        expect(f.requests.at(-1)?.systemPrompt).toBe("Base")
    } finally { await f.dispose() }
})

test("runtime shutdown closes active NoVibe connections", async () => {
    const f = fixture()
    try {
        await f.runtime.activateNovibe(f.first)
        await f.runtime.activateNovibe(f.second)
        await f.runtime.dispose()
        expect(f.closes).toHaveLength(2)
        for (const close of f.closes) expect(close).toHaveBeenCalledTimes(1)
    } finally { await f.dispose() }
})
