import { createAgentDefinition } from "@/agent/create-agent-definition"
import type { IAgentDeclaration, IAgentDefinition } from "@/agent/definition"
import { BULI_INSTRUCTIONS } from "@/agent/definitions/buli/instructions"
import type { IRuntimeAgentTool } from "@/agent/tool"
import type { IToolOutputStore } from "@/agent/tool-output-store"
import { FindTool } from "@/agent/tools/find/find-tool"
import { GrepTool } from "@/agent/tools/grep/grep-tool"
import { ReadTool } from "@/agent/tools/read/read-tool"
import { ReadToolOutputTool } from "@/agent/tools/read-tool-output/read-tool-output-tool"
import { createBashTool } from "@/agent/tools/bash/bash-tool"
import { createEditTool } from "@/agent/tools/edit/edit-tool"
import { createWriteTool } from "@/agent/tools/write/write-tool"

export interface IBuliAgentDependencies {
    readonly workspaceRoot: string
    readonly toolOutputStore: IToolOutputStore
    readonly fdExecutablePath?: string
    readonly ripgrepExecutablePath?: string
}

export const BuliAgent: IAgentDeclaration<IBuliAgentDependencies> = {
    id: "buli",
    name: "Buli",
    instructions: BULI_INSTRUCTIONS,
    tools: [
        ReadTool, FindTool, GrepTool, ReadToolOutputTool,
        {
            name: "edit",
            instructions: ["Use edit for targeted file changes after reading the relevant contents."],
            create: ({ workspaceRoot }) => createEditTool(workspaceRoot),
        },
        {
            name: "write",
            instructions: ["Use write to create files or replace their entire contents."],
            create: ({ workspaceRoot }) => createWriteTool(workspaceRoot),
        },
        {
            name: "bash",
            instructions: ["Prefer read, find, and grep for inspection, and edit or write for file changes; use bash for terminal operations."],
            create: ({ workspaceRoot, toolOutputStore }) => createBashTool(workspaceRoot, toolOutputStore),
        },
    ],
}

export function createBuliAgentDefinition(
    dependencies: IBuliAgentDependencies,
    options: {
        readonly tools?: readonly IRuntimeAgentTool[]
        readonly additionalTools?: readonly IRuntimeAgentTool[]
    } = {},
): IAgentDefinition {
    const suppliedTools = [...(options.tools ?? []), ...(options.additionalTools ?? [])]
    if (suppliedTools.some((tool) => tool.name === "tool_output")) {
        throw new Error('The tool name "tool_output" is reserved by Buli')
    }
    const bindTool = (tool: IRuntimeAgentTool) => ({
        name: tool.name,
        instructions: [],
        create: () => tool,
    })
    return createAgentDefinition({
        ...BuliAgent,
        instructions: [
            `Current working directory and workspace root: ${dependencies.workspaceRoot}.`,
            "All tool paths are resolved relative to the workspace unless the tool schema states otherwise.",
            BuliAgent.instructions,
        ].join("\n"),
        tools: [
            ...(options.tools === undefined
                ? BuliAgent.tools
                : [...options.tools.map(bindTool), ReadToolOutputTool]),
            ...(options.additionalTools ?? []).map(bindTool),
        ],
    }, dependencies)
}
