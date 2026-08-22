import {
    type IAgentTool,
    PATCH_HANDOFF_CONFIRMATION_QUESTION,
    PATCH_HANDOFF_TOOL_NAME,
} from "@/agent"

export { PATCH_HANDOFF_TOOL_NAME }

/** Creates a non-mutating marker for a conversational patch handoff. */
export function createRequestPatchHandoffTool(): IAgentTool {
    return {
        name: PATCH_HANDOFF_TOOL_NAME,
        description: [
            "Register that the user explicitly asked Buli to take over a concrete implementation scope.",
            "This tool never authorizes or prepares a patch.",
            "Use it only after the user's current message asks for implementation or takeover.",
            `After it completes, summarize the scope and end with exactly: "${PATCH_HANDOFF_CONFIRMATION_QUESTION}"`,
        ].join(" "),
        inputSchema: {
            type: "object",
            properties: {
                scope: {
                    type: "string",
                    minLength: 1,
                    description: "Concise implementation scope that will be confirmed",
                },
            },
            required: ["scope"],
            additionalProperties: false,
        },
        execute: async (input) => {
            const scope = input.scope
            if (typeof scope !== "string" || scope.trim().length === 0) {
                throw new TypeError("Tool input scope must be a non-empty string")
            }
            return {
                content: [
                    "Patch handoff confirmation is pending.",
                    `Scope: ${scope.trim()}`,
                    "Ask the user to reply exactly 'tak' to prepare one patch or 'nie' to continue the dialogue.",
                ].join("\n"),
                outcome: "completed",
                summary: "Waiting for patch handoff confirmation",
            }
        },
    }
}
