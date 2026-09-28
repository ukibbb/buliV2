import { ToolAccess } from "@/agent"
import type { McpConnection } from "@/mcp/mcp-connection"
import { createMcpTool } from "@/mcp/mcp-tool-adapter"
import type { IMcpSessionContribution } from "@/mcp/session-mcp-controller"

export const NOVIBE_SERVER_ID = "novibe"
export const NOVIBE_ENDPOINT = "http://127.0.0.1:8000/mcp/"
export const NOVIBE_READ_TOOL_NAMES = [
    "list_libraries",
    "get_document",
    "get_document_contents",
    "read_document_fragment",
] as const

export function createNovibeContribution(connection: McpConnection): IMcpSessionContribution {
    const tools = NOVIBE_READ_TOOL_NAMES.map((name) => {
        const matches = connection.tools.filter((tool) => tool.name === name)
        if (matches.length !== 1) throw new Error(`NoVibe: oczekiwano jednej definicji narzędzia ${name}.`)
        return createMcpTool({
            serverId: NOVIBE_SERVER_ID,
            tool: matches[0]!,
            access: ToolAccess.ReadOnly,
            callTool: connection.callTool.bind(connection),
        })
    })
    return {
        instructions: [connection.instructions, "W tej sesji NoVibe udostępnia wyłącznie odczyt. Narzędzia zapisu są niedostępne."].join("\n\n"),
        tools,
    }
}
