import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"

export type TMcpTool = Awaited<ReturnType<Client["listTools"]>>["tools"][number]
export type TMcpToolResult = Awaited<ReturnType<Client["callTool"]>>
export const DEFAULT_MCP_TIMEOUT_MS = 30_000

interface IMcpConnectionOptions {
    readonly endpoint: URL
    readonly clientInfo: { readonly name: string; readonly version: string }
    readonly signal: AbortSignal
    readonly timeoutMs?: number
}

/** One HTTP client. The caller owns closing it on deactivation or session shutdown. */
export class McpConnection {
    private closed = false

    private constructor(
        private readonly client: Client,
        private readonly timeoutMs: number,
        readonly instructions: string,
        readonly tools: readonly TMcpTool[],
    ) {}

    static async connect(options: IMcpConnectionOptions): Promise<McpConnection> {
        const timeoutMs = options.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
            throw new Error("MCP timeout must be a positive finite number")
        }
        options.signal.throwIfAborted()
        const client = new Client(options.clientInfo)
        const transport = new StreamableHTTPClientTransport(options.endpoint)
        const signal = AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])
        try {
            await client.connect(transport, { signal, timeout: timeoutMs })
            // SDK v2 aggregates paginated results and limits the number of pages.
            const { tools } = await client.listTools(undefined, { signal, timeout: timeoutMs })
            signal.throwIfAborted()
            return new McpConnection(client, timeoutMs, client.getInstructions() ?? "", tools)
        } catch (error) {
            try { await client.close() } catch { /* Preserve the original connection failure. */ }
            throw error
        }
    }

    async callTool(tool: TMcpTool, input: Record<string, unknown>, signal: AbortSignal): Promise<TMcpToolResult> {
        if (this.closed) throw new Error("MCP connection is closed")
        signal.throwIfAborted()
        return this.client.callTool({ name: tool.name, arguments: input }, {
            signal,
            timeout: this.timeoutMs,
            toolDefinition: tool,
        })
    }

    async close(): Promise<void> {
        if (this.closed) return
        this.closed = true
        await this.client.close()
    }
}
