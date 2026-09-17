import { expect, test } from "bun:test"

import { createAgentDefinition } from "@/agent/create-agent-definition"
import type { IAgentToolDeclaration } from "@/agent/definition"
import type { IRuntimeAgentTool } from "@/agent/tool"

test("agents independently compose selected tools and their instructions", () => {
    const dependencies = { workspaceRoot: "/workspace" }
    const receivedDependencies: typeof dependencies[] = []
    const readInstance = runtimeTool("read")
    const grepInstance = runtimeTool("grep")
    const ReadTool: IAgentToolDeclaration<typeof dependencies> = {
        name: "read",
        instructions: ["Read instruction"],
        create: (context) => {
            receivedDependencies.push(context)
            return readInstance
        },
    }
    const GrepTool: IAgentToolDeclaration<typeof dependencies> = {
        name: "grep",
        instructions: ["Grep instruction"],
        create: (context) => {
            receivedDependencies.push(context)
            return grepInstance
        },
    }

    const reviewer = createAgentDefinition({
        id: "reviewer",
        name: "Reviewer",
        instructions: "Review code.",
        tools: [ReadTool, GrepTool],
    }, dependencies)
    const reader = createAgentDefinition({
        id: "reader",
        name: "Reader",
        instructions: "Read code.",
        tools: [ReadTool],
    }, dependencies)

    expect(reviewer.id).toBe("reviewer")
    expect(reviewer.name).toBe("Reviewer")
    expect(reviewer.tools).toEqual([readInstance, grepInstance])
    expect(reviewer.systemPrompt).toBe([
        "Review code.",
        "Active tools: read, grep.",
        "<tools>",
        "Read instruction",
        "Grep instruction",
        "</tools>",
    ].join("\n"))
    expect(reader.tools).toEqual([readInstance])
    expect(reader.systemPrompt).toBe([
        "Read code.",
        "Active tools: read.",
        "<tools>",
        "Read instruction",
        "</tools>",
    ].join("\n"))
    expect(receivedDependencies).toHaveLength(3)
    for (const received of receivedDependencies) {
        expect(received).toBe(dependencies)
    }
})

test("an agent without tools has no tool instruction section", () => {
    const definition = createAgentDefinition({
        id: "conversation",
        name: "Conversation",
        instructions: "Answer questions.",
        tools: [],
    }, {})

    expect(definition.tools).toEqual([])
    expect(definition.systemPrompt).toBe(
        "Answer questions.\nActive tools: none.",
    )
})

test("duplicate tool names fail before any factory runs", () => {
    let calls = 0
    const tool: IAgentToolDeclaration<{}> = {
        name: "read",
        instructions: [],
        create: () => {
            calls += 1
            return runtimeTool("read")
        },
    }

    expect(() => createAgentDefinition({
        id: "duplicate",
        name: "Duplicate",
        instructions: "Inspect code.",
        tools: [tool, { ...tool }],
    }, {})).toThrow("Duplicate agent tool: read")
    expect(calls).toBe(0)
})

test("a factory cannot return a tool with a different name", () => {
    const tool: IAgentToolDeclaration<{}> = {
        name: "read",
        instructions: [],
        create: () => runtimeTool("write"),
    }

    expect(() => createAgentDefinition({
        id: "mismatch",
        name: "Mismatch",
        instructions: "Inspect code.",
        tools: [tool],
    }, {})).toThrow("Agent tool name mismatch: expected read, received write")
})

function runtimeTool(name: string): IRuntimeAgentTool {
    return {
        name,
        description: `${name} test tool`,
        inputSchema: { type: "object" },
        validateAndExecute: async () => "Test result",
    }
}
