import { expect, spyOn, test } from "bun:test"
import { BuliApplicationRuntime } from "@/app/runtime"
import { McpConnection } from "@/mcp/mcp-connection"
import { NOVIBE_READ_TOOL_NAMES } from "@/mcp/novibe"
import { InMemorySessionManager } from "@/sessions"
import type { IAgentModelRequest } from "@/agent/model"

function fixture(options: { missingTool?: boolean; waitForList?: Promise<void> } = {}) {
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
                    serverInfo: { name: "test", version: "1" }, instructions: "Test NoVibe instructions" })
            }
            if (message.method === "tools/list") {
                listStarted.resolve()
                await options.waitForList
                const names = options.missingTool ? [] : [...NOVIBE_READ_TOOL_NAMES, "edit_document", "create_document"]
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
    const runtime = new BuliApplicationRuntime({
        workspaceRoot: "/workspace", manager: new InMemorySessionManager(),
        agents: [{ id: "test", name: "Test", systemPrompt: "Base", tools: [] }], defaultAgentId: "test",
        models: [{ id: "test", name: "Test", reasoningEfforts: ["medium"], defaultReasoningEffort: "medium",
            model: { async *stream(request) { requests.push(request); yield { type: "finish", reason: "stop" } } } }],
        selection: { modelId: "test", reasoningEffort: "medium" }, generateId: () => `session-${++id}`,
    })
    const first = runtime.createSession({ agentId: "test", title: "First" }).id
    const second = runtime.createSession({ agentId: "test", title: "Second" }).id
    return {
        runtime, first, second, requests, closes, listStarted: listStarted.promise,
        initializations: () => initializations,
        async prompt(sessionId: string) { await runtime.submitPrompt({ sessionId, text: "Read" }).runFinished },
        async dispose() {
            try { await runtime.dispose() } finally { connectSpy.mockRestore(); await server.stop(true) }
        },
    }
}

test("NoVibe activation is session-local, read-only and idempotent; off preserves history", async () => {
    const f = fixture()
    try {
        await f.runtime.activateNovibe(f.first)
        expect(await f.runtime.activateNovibe(f.first)).toContain("aktywne")
        expect(f.initializations()).toBe(1)
        expect(f.runtime.openSession(f.first).getSnapshot().messages).toHaveLength(0)
        await f.prompt(f.first)
        expect(f.requests.at(-1)?.tools.map((tool) => tool.name)).toEqual(NOVIBE_READ_TOOL_NAMES.map((name) => `novibe__${name}`))
        expect(f.requests.at(-1)?.systemPrompt).toContain("Test NoVibe instructions")
        await f.prompt(f.second)
        expect(f.requests.at(-1)?.tools).toHaveLength(0)
        const history = f.runtime.openSession(f.first).getSnapshot().messages
        await f.runtime.deactivateNovibe(f.first)
        expect(f.runtime.openSession(f.first).getSnapshot().messages).toEqual(history)
        expect(f.closes[0]).toHaveBeenCalledTimes(1)
        await f.prompt(f.first)
        expect(f.requests.at(-1)?.tools).toHaveLength(0)
        expect(f.requests.at(-1)?.systemPrompt).toBe("Base")
    } finally { await f.dispose() }
})

test("invalid discovery closes the connection without activating NoVibe", async () => {
    const f = fixture({ missingTool: true })
    try {
        await expect(f.runtime.activateNovibe(f.first)).rejects.toThrow("list_libraries")
        expect(f.closes[0]).toHaveBeenCalledTimes(1)
        await f.prompt(f.first)
        expect(f.requests.at(-1)?.tools).toHaveLength(0)
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
