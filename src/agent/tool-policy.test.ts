import { expect, test } from "bun:test"
import { defineAgentTool } from "@/agent/tool"
import { isToolAllowed, ToolAccess, ToolPolicy, type TToolPolicy } from "@/agent/tool-policy"

test("source policy and branch policy both restrict local and MCP tools", () => {
    for (const source of [{ kind: "local" } as const, { kind: "mcp", serverId: "novibe" } as const]) {
        const tool = defineAgentTool({
            name: "edit",
            description: "edit",
            inputSchema: { type: "object" },
            access: ToolAccess.MayMutate,
            sourceBinding: { source, toolName: "edit", policy: ToolPolicy.Full },
            async execute() { return "done" },
        })
        expect(isToolAllowed(tool, ToolPolicy.Full)).toBe(true)
        expect(isToolAllowed(tool, ToolPolicy.ReadOnly)).toBe(false)
        expect(isToolAllowed({
            ...tool,
            sourceBinding: { ...tool.sourceBinding!, policy: ToolPolicy.ReadOnly },
        }, ToolPolicy.Full)).toBe(false)
    }
})

for (const access of [undefined, ToolAccess.ReadOnly, ToolAccess.MayMutate]) {
    test(`tool policy handles access ${access}`, () => {
        const tool = defineAgentTool({
            name: "test",
            description: "test",
            inputSchema: { type: "object" },
            ...(access === undefined ? {} : { access }),
            async execute() { return "done" },
        })
        expect(isToolAllowed(tool, ToolPolicy.Full)).toBe(true)
        expect(isToolAllowed(tool, ToolPolicy.ReadOnly)).toBe(access === ToolAccess.ReadOnly)
        expect(isToolAllowed(tool, "unknown" as TToolPolicy)).toBe(false)
    })
}
