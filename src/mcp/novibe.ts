import { ToolAccess, ToolPolicy, type TToolPolicy } from "@/agent"
import type { McpConnection } from "@/mcp/mcp-connection"
import { createMcpTool } from "@/mcp/mcp-tool-adapter"
import type { IMcpSessionContribution } from "@/mcp/session-mcp-controller"

export interface McpServerConfiguration {
    readonly id: string
    readonly endpoint: string
    readonly policy: TToolPolicy
}

export const NOVIBE_CONFIGURATION = {
    id: "novibe",
    endpoint: "http://127.0.0.1:8000/mcp/",
    policy: ToolPolicy.Full,
} satisfies McpServerConfiguration

export const NOVIBE_SERVER_ID = NOVIBE_CONFIGURATION.id
export const NOVIBE_ENDPOINT = NOVIBE_CONFIGURATION.endpoint

/** Trusted read classifications, not a discovery allowlist. */
export const NOVIBE_READ_TOOL_NAMES = [
    "list_libraries",
    "get_document",
    "get_document_contents",
    "read_document_fragment",
] as const

const readToolNames = new Set<string>(NOVIBE_READ_TOOL_NAMES)

export function createNovibeContribution(connection: McpConnection): IMcpSessionContribution {
    const tools = connection.tools.map((tool) => ({
        ...createMcpTool({
            serverId: NOVIBE_CONFIGURATION.id,
            tool,
            access: readToolNames.has(tool.name) ? ToolAccess.ReadOnly : ToolAccess.MayMutate,
            callTool: connection.callTool.bind(connection),
        }),
        sourceBinding: {
            source: { kind: "mcp" as const, serverId: NOVIBE_CONFIGURATION.id },
            toolName: tool.name,
            policy: NOVIBE_CONFIGURATION.policy,
        },
    }))
    return { instructions: connection.instructions, tools }
}
