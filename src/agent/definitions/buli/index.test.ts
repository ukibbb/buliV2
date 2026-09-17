import { expect, test } from "bun:test"

import { createBuliAgentDefinition } from "@/agent/definitions/buli"
import { BULI_INSTRUCTIONS } from "@/agent/definitions/buli/instructions"
import { defineAgentTool } from "@/agent/tool"
import { EphemeralToolOutputStore } from "@/agent/tools/output/ephemeral-tool-output-store"

test("Buli selects inspection and action tools and composes their instructions with its unchanged role", () => {
    const definition = createBuliAgentDefinition({
        workspaceRoot: "/workspace",
        toolOutputStore: new EphemeralToolOutputStore(),
    })

    expect(definition.id).toBe("buli")
    expect(definition.name).toBe("Buli")
    expect(definition.tools.map((tool) => tool.name)).toEqual([
        "read", "find", "grep", "tool_output", "edit", "write", "bash",
    ])
    expect(definition.systemPrompt).toContain(BULI_INSTRUCTIONS)
    expect(definition.systemPrompt).toContain("Current working directory and workspace root: /workspace.")
    expect(definition.systemPrompt).toContain("Active tools: read, find, grep, tool_output, edit, write, bash.")
    expect(definition.systemPrompt).toContain("### Text reading")
    expect(definition.systemPrompt).toContain("### File discovery")
    expect(definition.systemPrompt).toContain("### Content search")
    expect(definition.systemPrompt).toContain("### Retained tool output")
    for (const disabled of ["<general>", "<intent_routing>", "### File-change", "### Bash", "<workspace_instructions"]) {
        expect(definition.systemPrompt).not.toContain(disabled)
    }
})

test("injected tools replace defaults and additional provider tools retain their implementation", () => {
    const review = defineAgentTool({
        name: "review",
        description: "Review code",
        inputSchema: { type: "object" },
        execute: async () => "Reviewed",
    })
    const search = defineAgentTool({
        name: "web_search",
        description: "Search the web",
        inputSchema: { type: "object" },
        execute: async () => "Found",
    })
    const definition = createBuliAgentDefinition({
        workspaceRoot: "/workspace",
        toolOutputStore: new EphemeralToolOutputStore(),
    }, { tools: [review], additionalTools: [search] })

    expect(definition.tools.map((tool) => tool.name)).toEqual(["review", "tool_output", "web_search"])
    expect(definition.tools[0]).toBe(review)
    expect(definition.tools[2]).toBe(search)
    expect(definition.systemPrompt).toContain("Active tools: review, tool_output, web_search.")
    expect(definition.systemPrompt).not.toContain("### Text reading")
    expect(definition.systemPrompt).not.toContain("### File discovery")
    expect(definition.systemPrompt).not.toContain("### Content search")
})

test("Buli keeps the output pager when workspace tools are explicitly disabled", () => {
    const definition = createBuliAgentDefinition({
        workspaceRoot: "/workspace",
        toolOutputStore: new EphemeralToolOutputStore(),
    }, { tools: [] })
    expect(definition.tools.map((tool) => tool.name)).toEqual(["tool_output"])
    expect(definition.systemPrompt).toContain("Active tools: tool_output.")
})

test("injected tools cannot replace Buli's output pager", () => {
    const output = defineAgentTool({
        name: "tool_output",
        description: "Conflicting output pager",
        inputSchema: { type: "object" },
        execute: async () => "Unexpected",
    })
    const dependencies = { workspaceRoot: "/workspace", toolOutputStore: new EphemeralToolOutputStore() }
    expect(() => createBuliAgentDefinition(dependencies, { tools: [output] })).toThrow("reserved by Buli")
    expect(() => createBuliAgentDefinition(dependencies, { additionalTools: [output] })).toThrow("reserved by Buli")
})
