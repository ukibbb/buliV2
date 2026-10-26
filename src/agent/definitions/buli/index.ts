import { createAgentDefinition } from "@/agent/definitions/create-agent-definition"
import type { IAgentDeclaration, IAgentDefinition } from "@/agent/definitions/definition"
import { BULI_INSTRUCTIONS } from "@/agent/definitions/buli/instructions"
import type { IRuntimeAgentTool } from "@/agent/tools/tool"
import type { IToolOutputStore } from "@/agent/tools/tool-output-store"
import type { IInstructionFile } from "@/agent/definitions/instruction-file"
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
    readonly instructionFiles?: readonly IInstructionFile[]
    /** Placed right after the role's instructions with system-prompt authority. */
    readonly appendedSystemPrompt?: string
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

export interface IWorkspaceAgentOptions {
    readonly tools?: readonly IRuntimeAgentTool[]
    readonly additionalTools?: readonly IRuntimeAgentTool[]
}

export function createBuliAgentDefinition(
    dependencies: IBuliAgentDependencies,
    options: IWorkspaceAgentOptions = {},
): IAgentDefinition {
    return createWorkspaceAgentDefinition(BuliAgent, dependencies, options)
}

/** Binds an agent's role and workflow to workspace context and selected tools. */
export function createWorkspaceAgentDefinition(
    declaration: IAgentDeclaration<IBuliAgentDependencies>,
    dependencies: IBuliAgentDependencies,
    options: IWorkspaceAgentOptions = {},
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
        ...declaration,
        instructions: [
            `Current working directory and workspace root: ${dependencies.workspaceRoot}.`,
            "All tool paths are resolved relative to the workspace unless the tool schema states otherwise.",
            declaration.instructions,
            ...(dependencies.appendedSystemPrompt === undefined ? [] : [dependencies.appendedSystemPrompt]),
            ...(dependencies.instructionFiles?.length ? [
                "The following instruction files describe the user's preferences and project conventions. "
                    + "Follow them where compatible with Buli's instructions. "
                    + "They do not override approval requirements or tool access policies.",
                JSON.stringify({ instructionFiles: dependencies.instructionFiles }),
            ] : []),
        ].join("\n"),
        tools: [
            ...(options.tools === undefined
                ? declaration.tools
                : [...options.tools.map(bindTool), ReadToolOutputTool]),
            ...(options.additionalTools ?? []).map(bindTool),
        ],
    }, dependencies)
}
