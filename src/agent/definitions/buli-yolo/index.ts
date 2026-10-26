import {
    BuliAgent,
    createWorkspaceAgentDefinition,
    type IBuliAgentDependencies,
    type IWorkspaceAgentOptions,
} from "@/agent/definitions/buli"
import { BASH_EXECUTION_DESCRIPTION } from "@/agent/tools/bash/bash-tool"
import { ROLE_INSTRUCTIONS } from "@/agent/definitions/shared/role-instructions"
import workflowInstructions from "./instructions.txt" with { type: "text" }

export const BULI_YOLO_AGENT_ID = "buli-yolo"

/** Builds YOLO independently of Buli's approval-based workflow. */
export function createBuliYoloAgentDefinition(
    dependencies: IBuliAgentDependencies,
    options: IWorkspaceAgentOptions = {},
) {
    return createWorkspaceAgentDefinition({
        id: BULI_YOLO_AGENT_ID,
        name: "Buli YOLO",
        instructions: [ROLE_INSTRUCTIONS, workflowInstructions].join("\n\n"),
        tools: BuliAgent.tools.map(tool => tool.name === "bash" ? {
            ...tool,
            description: `${BASH_EXECUTION_DESCRIPTION} Execute local commands needed for the assigned task without asking for additional approval, including read-only commands and tests. Do not ask for approval of individual tool calls. This does not authorize unagreed destructive operations or production actions. Prefer read, find, and grep for inspection, and edit or write for file changes.`,
        } : tool),
    }, dependencies, options)
}
