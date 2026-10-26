import { expect, test } from "bun:test"

import { createSubagentDefinition } from "@/agent/definitions/subagent"
import { EphemeralToolOutputStore } from "@/agent/tools/output/ephemeral-tool-output-store"

test("a subagent gets only its tools plus tool_output, a Bash that needs no approval, and the instruction files", () => {
    const definition = createSubagentDefinition({
        workspaceRoot: "/workspace",
        toolOutputStore: new EphemeralToolOutputStore(),
        instructionFiles: [{ source: "CLAUDE.md", content: "Keep it simple." }],
    }, { id: "reviewer", description: "Review", instructions: "You review code.", toolNames: ["read", "grep", "bash"] })

    expect(definition.id).toBe("reviewer")
    expect(definition.tools.map((tool) => tool.name)).toEqual(["read", "grep", "bash", "tool_output"])
    expect(definition.tools.find((tool) => tool.name === "bash")!.description).toContain("without asking for approval")
    expect(definition.systemPrompt).toContain("You review code.")
    expect(definition.systemPrompt).toContain("Workspace root: /workspace.")
    expect(definition.systemPrompt).toContain(JSON.stringify([{ source: "CLAUDE.md", content: "Keep it simple." }]))
})
