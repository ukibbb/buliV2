import { expect, test } from "bun:test"
import { ToolAccess } from "@/agent/tool-policy"
import type { IAgentToolContext } from "@/agent/tool"
import { McpConnection, type TMcpTool } from "@/mcp/mcp-connection"
import { createMcpTool } from "@/mcp/mcp-tool-adapter"

const remoteTool: TMcpTool = {
    name: "read_note",
    description: "Read a test note",
    inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
    },
}
const context: IAgentToolContext = {
    sessionId: "test-session", runId: "test-run", toolCallId: "test-call",
    signal: new AbortController().signal,
}

interface IRequest {
    readonly id?: string | number
    readonly method: string
    readonly params?: { readonly name?: string; readonly arguments?: unknown }
}

/** Minimal stateless MCP HTTP peer; it never accesses application data. */
function startServer() {
    const calls: IRequest[] = []
    const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
            if (request.method !== "POST") return new Response(null, { status: 405 })
            const message = await request.json() as IRequest
            if (message.id === undefined) return new Response(null, { status: 202 })
            const respond = (result: unknown) => Response.json({ jsonrpc: "2.0", id: message.id, result })
            switch (message.method) {
                case "initialize":
                    return respond({
                        protocolVersion: "2025-11-25",
                        capabilities: { tools: {} },
                        serverInfo: { name: "test-notes", version: "1.0.0" },
                        instructions: "Read test notes only.",
                    })
                case "tools/list":
                    return respond({ tools: [remoteTool] })
                case "tools/call":
                    calls.push(message)
                    return respond({ content: [{ type: "text", text: "Test note content" }] })
                default:
                    return Response.json({
                        jsonrpc: "2.0", id: message.id,
                        error: { code: -32601, message: "Method not found" },
                    })
            }
        },
    })
    return { server, calls }
}

test("Buli executor reads through HTTP MCP and rejects invalid arguments before sending", async () => {
    const { server, calls } = startServer()
    let connection: McpConnection | undefined
    try {
        connection = await McpConnection.connect({
            endpoint: new URL("/mcp/", server.url),
            clientInfo: { name: "buli-test", version: "1.0.0" },
            signal: context.signal,
        })
        expect(connection.instructions).toBe("Read test notes only.")
        expect(connection.tools).toHaveLength(1)
        const tool = createMcpTool({
            serverId: "novibe", tool: connection.tools[0]!, access: ToolAccess.ReadOnly,
            callTool: connection.callTool.bind(connection),
        })
        expect(tool.name).toBe("novibe__read_note")
        expect(await tool.validateAndExecute({ id: 123 }, context)).toMatchObject({ outcome: "rejected" })
        expect(await tool.validateAndExecute({ id: "note", extra: true }, context)).toMatchObject({ outcome: "rejected" })
        expect(calls).toHaveLength(0)
        expect(await tool.validateAndExecute({ id: "note" }, context)).toEqual({
            content: "Test note content", outcome: "completed",
        })
        expect(calls).toHaveLength(1)
        expect(calls[0]?.params).toEqual({ name: "read_note", arguments: { id: "note" } })
        await connection.close()
        await connection.close()
        await expect(connection.callTool(remoteTool, { id: "note" }, context.signal)).rejects.toThrow("closed")
    } finally {
        try { await connection?.close() } finally { await server.stop(true) }
    }
})

test("an already cancelled connection does not start initialization", async () => {
    await expect(McpConnection.connect({
        endpoint: new URL("http://127.0.0.1:1/mcp/"),
        clientInfo: { name: "buli-test", version: "1.0.0" },
        signal: AbortSignal.abort(new Error("Cancelled by test")),
    })).rejects.toThrow("Cancelled by test")
})

test("MCP connection rejects invalid timeout configuration", async () => {
    for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        await expect(McpConnection.connect({
            endpoint: new URL("http://127.0.0.1:1/mcp/"),
            clientInfo: { name: "buli-test", version: "1.0.0" },
            signal: context.signal, timeoutMs,
        })).rejects.toThrow("positive finite")
    }
})
