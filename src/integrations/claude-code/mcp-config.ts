import { readFile } from "node:fs/promises"

import type { IRuntimeAgentTool } from "@/agent"
import { type IMcpClientInfo, type IMcpStdioCommand, McpConnection } from "@/mcp/mcp-connection"
import { createMcpTool } from "@/mcp/mcp-tool-adapter"

/** One stdio server from a Claude Code `--mcp-config` file. */
export interface IConfiguredMcpServer extends IMcpStdioCommand {
    readonly id: string
}

/** Tools and prompt instructions of the connected servers; `close` ends their processes. */
export interface IConfiguredMcpTools {
    readonly tools: readonly IRuntimeAgentTool[]
    readonly instructions: string
    readonly close: () => Promise<void>
}

/** Reads `{ "mcpServers": { id: { command, args, env } } }`, expanding `${VAR}` like Claude Code. Only stdio servers are supported. */
export async function loadMcpConfig(path: string, signal: AbortSignal): Promise<readonly IConfiguredMcpServer[]> {
    let config: unknown
    try {
        config = JSON.parse(await readFile(path, { encoding: "utf8", signal }))
    } catch (cause) {
        signal.throwIfAborted()
        throw new Error(`Unable to read MCP config: ${path}`, { cause })
    }
    const servers = isRecord(config) && isRecord(config.mcpServers) ? config.mcpServers : undefined
    if (!servers) throw new Error(`MCP config must contain an "mcpServers" object: ${path}`)
    return Object.entries(servers).map(([id, server]) => {
        if (!isRecord(server) || typeof server.command !== "string") {
            throw new Error(`MCP server "${id}" needs a stdio "command"; HTTP servers are not supported in ${path}`)
        }
        const args = server.args ?? []
        const env = server.env ?? {}
        if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string")
            || !isRecord(env) || !Object.values(env).every((value) => typeof value === "string")) {
            throw new Error(`MCP server "${id}" needs string "args" and "env" values in ${path}`)
        }
        return {
            id,
            command: expand(server.command),
            args: args.map(expand),
            env: Object.fromEntries(Object.entries(env as Record<string, string>).map(([key, value]) => [key, expand(value)])),
        }
    })
}

/**
 * Starts every configured server. Their tools may change data: Buli never trusts a server's own
 * read-only annotation, so they stay out of read-only branches. One failure closes the others.
 */
export async function connectConfiguredServers(
    servers: readonly IConfiguredMcpServer[],
    clientInfo: IMcpClientInfo,
    signal: AbortSignal,
): Promise<IConfiguredMcpTools> {
    const attempts = await Promise.allSettled(servers.map((server) =>
        McpConnection.connect({ endpoint: server, clientInfo, signal }).then(
            (connection) => ({ id: server.id, connection }),
            (cause: unknown) => { throw new Error(`Unable to start MCP server "${server.id}"`, { cause }) },
        )
    ))
    const started = attempts.flatMap((attempt) => attempt.status === "fulfilled" ? [attempt.value] : [])
    const close = async () => { await Promise.allSettled(started.map(({ connection }) => connection.close())) }
    const failure = attempts.find((attempt): attempt is PromiseRejectedResult => attempt.status === "rejected")
    if (failure) {
        await close()
        throw failure.reason
    }
    return {
        tools: started.flatMap(({ id, connection }) => connection.tools.map((tool) => createMcpTool({
            serverId: id,
            tool,
            callTool: connection.callTool.bind(connection),
        }))),
        instructions: started.flatMap(({ id, connection }) => {
            const text = connection.instructions.trim()
            return text ? [`# MCP server "${id}"\n${text}`] : []
        }).join("\n\n"),
        close,
    }
}

/** An unset variable is a configuration error, not an empty path segment. */
function expand(value: string): string {
    return value.replace(/\$\{(\w+)\}/g, (_, name: string) => {
        const variable = process.env[name]
        if (variable === undefined) throw new Error(`MCP config uses unset variable \${${name}}`)
        return variable
    })
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}
