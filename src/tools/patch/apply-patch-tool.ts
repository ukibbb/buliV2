import type { IAgentTool } from "@/agent"
import { prepareWorkspacePatch } from "@/tools/patch/patch-engine"

const INPUT_KEYS = new Set(["patchText", "explanation"])

const APPLY_PATCH_DESCRIPTION = [
    "Prepare workspace changes using a strict file-oriented patch. The tool validates the complete patch and shows the exact resulting diff for user approval before changing any file.",
    "",
    "Patch format:",
    "*** Begin Patch",
    "*** Add File: path/to/new-file.ts",
    "+Every added-file line starts with +",
    "*** Update File: path/to/existing-file.ts",
    "*** Move to: optional/new-path.ts",
    "@@ optional exact anchor",
    "-old line",
    "+new line",
    "*** Delete File: path/to/obsolete-file.ts",
    "*** End Patch",
    "",
    "Use workspace-relative paths. Group one small, coherent, already-explained change in each patch. Calling this tool proposes the change; only the user's explicit modal approval applies it.",
].join("\n")

/** Creates the approval-gated tool for applying exact workspace patches. */
export function createApplyPatchTool(workspaceRoot: string): IAgentTool {
    return {
        name: "apply_patch",
        approvalKind: "patch",
        description: APPLY_PATCH_DESCRIPTION,
        inputSchema: {
            type: "object",
            properties: {
                patchText: {
                    type: "string",
                    minLength: 1,
                    description: "Complete Codex patch envelope to plan and propose",
                },
                explanation: {
                    type: "string",
                    minLength: 1,
                    description: "Concise reason for the proposed workspace change",
                },
            },
            required: ["patchText", "explanation"],
            additionalProperties: false,
        },
        execute: async (input, context) => {
            assertOnlyInputKeys(input)
            const patchText = requireNonEmptyString(input, "patchText")
            const explanation = requireNonEmptyString(input, "explanation")
            const proposal = await prepareWorkspacePatch({
                patchText,
                workspaceRoot,
                signal: context.signal,
            })
            try {
                context.signal.throwIfAborted()
                const requestApproval = context.requestApproval
                if (!requestApproval) {
                    throw new Error(
                        "apply_patch cannot modify the workspace because tool approval is "
                        + "unavailable; no workspace files were changed.",
                    )
                }

                const decision = await requestApproval({
                    kind: "patch",
                    title: `Apply workspace patch: ${proposal.preview.summary.text}`,
                    explanation,
                    diff: proposal.preview.diff,
                    paths: proposal.preview.affectedPaths,
                })
                if (decision === "reject") {
                    return {
                        content: "Patch approval was rejected; no workspace files were changed.",
                        outcome: "rejected",
                        summary: "Patch rejected; workspace unchanged",
                    }
                }
                if (decision !== "approve") {
                    throw new Error(
                        `apply_patch requires an approve decision, received ${JSON.stringify(decision)}; `
                        + "no workspace files were changed.",
                    )
                }

                const result = await proposal.applyOnce(context.signal)
                return {
                    content: result.summary,
                    outcome: "completed",
                    summary: result.summary,
                }
            } finally {
                proposal.discard()
            }
        },
    }
}

function assertOnlyInputKeys(input: Record<string, unknown>): void {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
        throw new TypeError("Tool input must be an object")
    }
    for (const key of Object.keys(input)) {
        if (!INPUT_KEYS.has(key)) {
            throw new TypeError(`Tool input contains unknown property ${JSON.stringify(key)}`)
        }
    }
}

function requireNonEmptyString(
    input: Record<string, unknown>,
    key: string,
): string {
    const value = input[key]
    if (typeof value !== "string") {
        throw new TypeError(`Tool input ${key} must be a string`)
    }
    if (value.trim().length === 0) {
        throw new TypeError(`Tool input ${key} cannot be empty`)
    }
    return value
}
