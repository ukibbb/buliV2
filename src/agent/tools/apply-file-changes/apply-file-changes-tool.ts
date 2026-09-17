import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { Type } from "typebox"

import { defineAgentTool, type IAgentTool } from "@/agent/tool"
import type { FileChangeProposalStore } from "@/agent/tools/patch/file-change-proposal-store"
import { withFileMutationQueue } from "@/agent/tools/shared/file-mutation"
import { resolveToCwd } from "@/agent/tools/shared/path-utils"

const PROPOSAL_INPUT_SCHEMA = Type.Object({
    proposalId: Type.String({
        description: "Exact ID of the active file-change proposal",
    }),
})

/** Applies the exact target content stored in an accepted proposal. */
export function createApplyFileChangesTool(
    cwd: string,
    proposalStore: FileChangeProposalStore,
): IAgentTool<typeof PROPOSAL_INPUT_SCHEMA, "apply_file_changes"> {
    return defineAgentTool({
        name: "apply_file_changes",
        description:
            "Apply an active file-change proposal only after the user accepts it in a later message. The file must still match the version shown in the proposal.",
        inputSchema: PROPOSAL_INPUT_SCHEMA,
        execute: async ({ proposalId }, context) => {
            const proposal = proposalStore.getForApply(
                context.sessionId,
                proposalId,
                context.runId,
            )
            const absolutePath = resolveToCwd(proposal.path, cwd)

            return await withFileMutationQueue(absolutePath, async () => {
                context.signal.throwIfAborted()
                const currentContent = await readOptionalFile(absolutePath)
                context.signal.throwIfAborted()

                const targetAlreadyWritten =
                    currentContent === proposal.targetContent
                if (
                    currentContent !== proposal.baseContent
                    && !targetAlreadyWritten
                ) {
                    throw new Error(
                        `Could not apply proposal ${proposal.id}: ${proposal.path} changed after the proposal was created.`,
                    )
                }

                let wroteTarget = false
                if (!targetAlreadyWritten) {
                    await mkdir(dirname(absolutePath), { recursive: true })
                    context.signal.throwIfAborted()
                    await writeFile(
                        absolutePath,
                        proposal.targetContent,
                        "utf-8",
                    )
                    wroteTarget = true
                }

                try {
                    // Once the file changed, finish the synchronous durable state
                    // transition instead of exposing a cancellation gap.
                    proposalStore.resolve(
                        context.sessionId,
                        proposal.id,
                        "applied",
                    )
                } catch (persistenceError) {
                    if (wroteTarget) {
                        try {
                            await restoreProposalBase(
                                absolutePath,
                                proposal.baseContent,
                                proposal.targetContent,
                            )
                        } catch (rollbackError) {
                            throw new AggregateError(
                                [persistenceError, rollbackError],
                                `Applied proposal ${proposal.id}, but could not persist its status or restore ${proposal.path}.`,
                            )
                        }
                    }
                    throw persistenceError
                }

                return `Applied file-change proposal ${proposal.id} to ${proposal.path}.`
            })
        },
    })
}

async function readOptionalFile(path: string): Promise<string | undefined> {
    try {
        return await readFile(path, "utf-8")
    } catch (error) {
        if (
            error instanceof Error
            && "code" in error
            && error.code === "ENOENT"
        ) {
            return undefined
        }
        throw error
    }
}

async function restoreProposalBase(
    path: string,
    baseContent: string | undefined,
    targetContent: string,
): Promise<void> {
    if (await readOptionalFile(path) !== targetContent) {
        throw new Error("The file changed before the proposal could be rolled back.")
    }
    if (baseContent === undefined) {
        await rm(path, { force: true })
        return
    }
    await writeFile(path, baseContent, "utf-8")
}
