import { ROLE_INSTRUCTIONS } from "../shared/role-instructions"
import workflowInstructions from "./instructions.txt" with { type: "text" }

export const BULI_INSTRUCTIONS = [ROLE_INSTRUCTIONS, workflowInstructions].join("\n\n")
