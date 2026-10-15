import { QUALITY_INSTRUCTIONS } from "../shared/quality-instructions"
import workflowInstructions from "./instructions.txt" with { type: "text" }

export const BULI_INSTRUCTIONS = [QUALITY_INSTRUCTIONS, workflowInstructions].join("\n\n")
