import { expect, test } from "bun:test"
import { ToolAccess } from "@/agent/tool-policy"
import type { IAgentToolContext, TToolExecutionOutcome } from "@/agent/tool"
import type { TMcpTool, TMcpToolResult } from "@/mcp/mcp-connection"
import { createMcpTool } from "@/mcp/mcp-tool-adapter"

const descriptor: TMcpTool = {
    name: "test", inputSchema: { type: "object", additionalProperties: false },
}
const context: IAgentToolContext = {
    sessionId: "session", runId: "run", toolCallId: "call",
    signal: new AbortController().signal,
}

test("unknown access defaults to potentially mutating; transport failures are not retried", async () => {
    let attempts = 0
    const tool = createMcpTool({
        serverId: "test", tool: descriptor,
        async callTool() { attempts += 1; throw new Error("Connection lost") },
    })
    expect(tool.access).toBe(ToolAccess.MayMutate)
    expect(await tool.validateAndExecute({}, context)).toMatchObject({ outcome: "effects-unknown" })
    expect(attempts).toBe(1)
})

test("read transport failures produce failed rather than uncertain effects", async () => {
    const tool = createMcpTool({
        serverId: "test", tool: descriptor, access: ToolAccess.ReadOnly,
        async callTool() { throw new Error("Connection lost") },
    })
    expect(await tool.validateAndExecute({}, context)).toMatchObject({ outcome: "failed" })
})

test("cancelled execution does not call the remote executor", async () => {
    let attempts = 0
    const tool = createMcpTool({
        serverId: "test", tool: descriptor,
        async callTool() { attempts += 1; return { content: [] } },
    })
    await expect(tool.validateAndExecute({}, {
        ...context, signal: AbortSignal.abort(new Error("Cancelled")),
    })).rejects.toThrow("Cancelled")
    expect(attempts).toBe(0)
})

test("null, arrays and primitive inputs are rejected locally", async () => {
    let attempts = 0
    const tool = createMcpTool({
        serverId: "test", tool: descriptor,
        async callTool() { attempts += 1; return { content: [] } },
    })
    for (const input of [null, [], "", 1]) {
        expect(await tool.validateAndExecute(input, context)).toMatchObject({ outcome: "rejected" })
    }
    expect(attempts).toBe(0)
})

test("MCP error, structured and empty responses retain their meaning", async () => {
    const cases: { result: TMcpToolResult; content: string; outcome: TToolExecutionOutcome }[] = [
        { result: { content: [{ type: "text", text: "Not found" }], isError: true }, content: "Not found", outcome: "failed" },
        { result: { content: [], structuredContent: { id: "note" } }, content: '{"id":"note"}', outcome: "completed" },
        { result: { content: [] }, content: "Narzędzie MCP zwróciło pustą odpowiedź.", outcome: "completed" },
    ]
    for (const { result, content, outcome } of cases) {
        const tool = createMcpTool({ serverId: "test", tool: descriptor, async callTool() { return result } })
        expect(await tool.validateAndExecute({}, context)).toEqual({ content, outcome })
    }
})
