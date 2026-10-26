import { createAgentDefinition } from "@/agent/definitions/create-agent-definition"
import type { IAgentDefinition } from "@/agent/definitions/definition"
import { BuliAgent, type IBuliAgentDependencies } from "@/agent/definitions/buli"
import { BASH_EXECUTION_DESCRIPTION } from "@/agent/tools/bash/bash-tool"
import { ReadToolOutputTool } from "@/agent/tools/read-tool-output/read-tool-output-tool"

/** An agent defined outside Buli: its own instructions and a subset of Buli's tools. */
export interface ISubagentSpec {
    readonly id: string
    /** When to use the agent; shown to the parent model choosing one. */
    readonly description: string
    readonly instructions: string
    /** Buli tool names; `tool_output` is always added. */
    readonly toolNames: readonly string[]
}

/** A subagent has no user to ask, so its Bash runs what the task needs without approval. */
const SUBAGENT_BASH_DESCRIPTION = `${BASH_EXECUTION_DESCRIPTION} Run the commands your assigned task needs without asking for approval. This does not authorize destructive operations or production actions.`

/** Binds a subagent to the workspace like Explorer: its role, the workspace root and the instruction files. */
export function createSubagentDefinition(dependencies: Omit<IBuliAgentDependencies, "appendedSystemPrompt">, spec: ISubagentSpec): IAgentDefinition {
    const allowed = new Set(spec.toolNames)
    return createAgentDefinition({
        id: spec.id,
        name: spec.id,
        instructions: [
            spec.instructions,
            `Workspace root: ${dependencies.workspaceRoot}. Relative tool paths resolve from this directory.`,
            "You receive a self-contained task, not the parent's conversation. End with a concise, self-contained final report.",
            ...(dependencies.instructionFiles?.length ? [
                "Follow these user preferences and project conventions where compatible with your role:",
                JSON.stringify(dependencies.instructionFiles),
            ] : []),
        ].join("\n"),
        tools: [
            ...BuliAgent.tools
                .filter((tool) => tool.name !== ReadToolOutputTool.name && allowed.has(tool.name))
                .map((tool) => tool.name === "bash" ? { ...tool, description: SUBAGENT_BASH_DESCRIPTION } : tool),
            ReadToolOutputTool,
        ],
    }, dependencies)
}
