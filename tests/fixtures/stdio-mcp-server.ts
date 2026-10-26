// Minimal stdio MCP peer for tests: one tool that reports the MCP_TEST_ROLE environment variable it was started with.
const tool = {
    name: "read_role",
    description: "Report the memory role",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
}

let buffer = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk: string) => {
    buffer += chunk
    let newline: number
    while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line) respond(JSON.parse(line) as { id?: number | string; method: string })
    }
})

function respond(message: { id?: number | string; method: string }) {
    if (message.id === undefined) return
    const reply = (result: unknown) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`)
    switch (message.method) {
        case "initialize":
            return reply({
                protocolVersion: "2025-11-25",
                capabilities: { tools: {} },
                serverInfo: { name: "test-stdio", version: "1.0.0" },
                instructions: "Use read_role to learn the role.",
            })
        case "tools/list":
            return reply({ tools: [tool] })
        case "tools/call":
            return reply({ content: [{ type: "text", text: `role=${process.env.MCP_TEST_ROLE ?? "unset"}` }] })
        default:
            return process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } })}\n`)
    }
}
