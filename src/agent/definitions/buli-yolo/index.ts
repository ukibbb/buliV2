import {
    BuliAgent,
    createWorkspaceAgentDefinition,
    type IBuliAgentDependencies,
    type IWorkspaceAgentOptions,
} from "@/agent/definitions/buli"
import { QUALITY_INSTRUCTIONS } from "@/agent/definitions/shared/quality-instructions"
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
        instructions: [QUALITY_INSTRUCTIONS, workflowInstructions].join("\n\n"),
        tools: BuliAgent.tools,
    }, dependencies, options)
}
