import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { ToolAccess } from "@/agent/tools/tool-policy"
import { connectConfiguredServers, loadMcpConfig } from "@/mcp/configured-servers"

const SERVER_SCRIPT = resolve(import.meta.dir, "../../../tests/fixtures/stdio-mcp-server.ts")
const client = { name: "buli-test", version: "1.0.0" }
const signal = () => new AbortController().signal

async function withConfig(config: unknown, body: (path: string) => Promise<void>) {
    const directory = await mkdtemp(join(tmpdir(), "buli-mcp-config-"))
    try {
        const path = join(directory, "mcp.json")
        await writeFile(path, JSON.stringify(config))
        await body(path)
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
}

test("reads stdio servers and expands ${VAR} like Claude Code", async () => {
    process.env.BULI_TEST_HOME = "/home/test"
    await withConfig({
        mcpServers: { bulios: { command: "node", args: ["${BULI_TEST_HOME}/server.js"], env: { ROLE: "client" } } },
    }, async (path) => {
        expect(await loadMcpConfig(path, signal())).toEqual([
            { id: "bulios", command: "node", args: ["/home/test/server.js"], env: { ROLE: "client" } },
        ])
    })
})

test("rejects non-string arguments and unset variables instead of changing the command line", async () => {
    await withConfig({ mcpServers: { bulios: { command: "node", args: ["server.js", 3] } } }, async (path) => {
        await expect(loadMcpConfig(path, signal())).rejects.toThrow(/needs string "args" and "env"/)
    })
    delete process.env.BULI_TEST_UNSET
    await withConfig({ mcpServers: { bulios: { command: "node", args: ["${BULI_TEST_UNSET}/server.js"] } } }, async (path) => {
        await expect(loadMcpConfig(path, signal())).rejects.toThrow("MCP config uses unset variable ${BULI_TEST_UNSET}")
    })
})

test("rejects an HTTP server, which only Buli's built-in NoVibe connection supports", async () => {
    await withConfig({ mcpServers: { remote: { type: "http", url: "http://127.0.0.1:1/mcp" } } }, async (path) => {
        await expect(loadMcpConfig(path, signal())).rejects.toThrow(/"remote" needs a stdio "command"/)
    })
})

test("connects a stdio server whose tools run with the configured environment and stay mutating", async () => {
    const mcp = await connectConfiguredServers(
        [{ id: "notes", command: process.execPath, args: [SERVER_SCRIPT], env: { MCP_TEST_ROLE: "client" } }],
        client,
        signal(),
    )
    try {
        expect(mcp.tools.map((tool) => [tool.name, tool.access])).toEqual([["notes__read_role", ToolAccess.MayMutate]])
        expect(mcp.instructions).toBe('# MCP server "notes"\nUse read_role to learn the role.')
        const result = await mcp.tools[0]!.validateAndExecute({}, {
            sessionId: "s", runId: "r", toolCallId: "c", signal: signal(),
        })
        expect(result).toEqual({ content: "role=client", outcome: "completed" })
    } finally {
        await mcp.close()
    }
})

test("a server that fails to start names itself and closes the servers that started", async () => {
    await expect(connectConfiguredServers([
        { id: "notes", command: process.execPath, args: [SERVER_SCRIPT] },
        { id: "broken", command: "/nonexistent/buli-mcp-server", args: [] },
    ], client, signal())).rejects.toThrow('Unable to start MCP server "broken"')
})
