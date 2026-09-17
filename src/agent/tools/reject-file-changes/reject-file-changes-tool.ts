import { Type } from "typebox"

import { defineAgentTool, type IAgentTool } from "@/agent/tool"
import type { FileChangeProposalStore } from "@/agent/tools/patch/file-change-proposal-store"

const PROPOSAL_INPUT_SCHEMA = Type.Object({
    proposalId: Type.String({
        description: "Exact ID of the active file-change proposal",
    }),
})

/** Discards the active proposal without modifying its file. */
export function createRejectFileChangesTool(
    proposalStore: FileChangeProposalStore,
): IAgentTool<typeof PROPOSAL_INPUT_SCHEMA, "reject_file_changes"> {
    return defineAgentTool({
        name: "reject_file_changes",
        description:
            "Reject the active file-change proposal when the user declines it or requests a different change.",
        inputSchema: PROPOSAL_INPUT_SCHEMA,
        execute: async ({ proposalId }, context) => {
            context.signal.throwIfAborted()
            proposalStore.resolve(
                context.sessionId,
                proposalId,
                "rejected",
            )
            return `Rejected file-change proposal ${proposalId}.`
        },
    })
}
