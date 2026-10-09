import { expect, test } from "bun:test"
import { createNovibeAgentDefinition } from "./index"
import { EphemeralToolOutputStore } from "@/agent/tools/output/ephemeral-tool-output-store"
import { createOpenAiWebSearchTool } from "@/providers/openai"

test("NoVibe combines local read tools and internet without Buli instructions or local writes", async () => {
    const toolOutputStore = new EphemeralToolOutputStore()
    try {
        const webSearch = createOpenAiWebSearchTool({
            resolveBackend: async () => { throw new Error("Search must not run while creating an agent") },
        })
        const agent = createNovibeAgentDefinition({ workspaceRoot: "/workspace", toolOutputStore }, [webSearch])
        expect(agent.id).toBe("novibe")
        expect(agent.tools.map(tool => tool.name)).toEqual(["read", "find", "grep", "tool_output", "web_search"])
        expect(agent.systemPrompt).toContain("### Text reading")
        expect(agent.systemPrompt).not.toContain("Jesteś Buli")
        expect(agent.systemPrompt).not.toContain("workspaceInstructions")
    } finally { await toolOutputStore.dispose() }
})
