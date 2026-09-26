import { expect, test } from "bun:test"
import { defineAgentTool } from "@/agent/tool"
import { isToolAllowed, ToolAccess, ToolPolicy, type TToolPolicy } from "@/agent/tool-policy"

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
