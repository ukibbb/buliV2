import { Check } from "typebox/schema"
import { ToolAccess, type TToolAccess, type IAgentToolResult, type IRuntimeAgentTool } from "@/agent"
import type { TMcpTool, TMcpToolResult } from "@/mcp/mcp-connection"

interface IMcpToolAdapterOptions {
    readonly serverId: string
    readonly tool: TMcpTool
    /** Host-owned policy; never infer permission from a remote name or annotation. */
    readonly access?: TToolAccess
    readonly callTool: (
        tool: TMcpTool,
        input: Record<string, unknown>,
        signal: AbortSignal,
    ) => Promise<TMcpToolResult>
}

const TOOL_NAME_SEPARATOR = "__"

export function createMcpTool(options: IMcpToolAdapterOptions): IRuntimeAgentTool {
    const tool = structuredClone(options.tool)
    const access = options.access ?? ToolAccess.MayMutate
    return {
        name: `${options.serverId}${TOOL_NAME_SEPARATOR}${tool.name}`,
        description: tool.description ?? tool.name,
        inputSchema: tool.inputSchema,
        access,
        async validateAndExecute(input, context) {
            context.signal.throwIfAborted()
            if (!isRecord(input) || !Check(tool.inputSchema, input)) {
                return { content: `Invalid arguments for MCP tool "${tool.name}"`, outcome: "rejected" }
            }
            let result: TMcpToolResult
            try {
                result = await options.callTool(tool, input, context.signal)
            } catch {
                // A transport/SDK failure is not proof that a remote write did not happen.
                return {
                    content: access === ToolAccess.ReadOnly
                        ? "Nie otrzymano potwierdzonego wyniku odczytu MCP."
                        : "Nie otrzymano potwierdzonego wyniku MCP. Operacja mogła zmienić dane. Sprawdź ich stan przed ponowieniem.",
                    outcome: access === ToolAccess.ReadOnly ? "failed" : "effects-unknown",
                }
            }
            return convertResult(result)
        },
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function convertResult(result: TMcpToolResult): IAgentToolResult {
    const parts: string[] = []
    for (const block of result.content) {
        if (block.type === "text") parts.push(block.text)
        else parts.push(`[Nieobsługiwany blok wyniku MCP: ${block.type}]`)
    }
    if (result.structuredContent !== undefined) {
        parts.push(JSON.stringify(result.structuredContent))
    }
    return {
        content: parts.join("\n\n") || "Narzędzie MCP zwróciło pustą odpowiedź.",
        outcome: result.isError ? "failed" : "completed",
    }
}
