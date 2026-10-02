import type {
    IAgentContextProjection,
    TAgentMessage,
} from "@/agent"
import {
    assertCheckpointAnchor,
    type ICompactionCheckpoint,
} from "@/sessions/compaction/checkpoint"
import { eligibleCompactionEnd } from "@/sessions/compaction/session-compactor"
import type { IRequiredContext } from "@/sessions/history-contracts"
import { assertCompactionCheckpoint } from "@/sessions/validation"

/** Projects full durable history; the SQLite reader supplies the same contract selectively. */
export function projectAgentContext(
    messages: readonly TAgentMessage[],
    checkpoint?: ICompactionCheckpoint,
): IAgentContextProjection {
    const context = projectRequiredContext(messages, checkpoint)
    return {
        messages: context.messages,
        ...(context.contextSummary === undefined ? {} : { contextSummary: context.contextSummary }),
    }
}

/** Transitional full-history projection, keeping only the checkpoint actually used. */
export function projectRequiredContext(
    messages: readonly TAgentMessage[],
    checkpoint?: ICompactionCheckpoint,
): IRequiredContext {
    if (!checkpoint) return { messages: structuredClone(messages) }

    if (messages.some((message) => message.sessionId !== checkpoint.sessionId)) {
        throw new Error("Compaction checkpoint belongs to another session")
    }
    assertCheckpointAnchor(checkpoint, messages)
    let safeCompactionEnd: number
    try {
        safeCompactionEnd = eligibleCompactionEnd(messages)
    } catch {
        return { messages: structuredClone(messages) }
    }
    if (checkpoint.compactedMessageCount > safeCompactionEnd) {
        return { messages: structuredClone(messages) }
    }
    return {
        messages: structuredClone(
            messages.slice(checkpoint.compactedMessageCount),
        ),
        contextSummary: checkpoint.summary,
        checkpoint: structuredClone(checkpoint),
    }
}

/** Evaluates an unsaved candidate against one captured context, without reading or changing storage. */
export function projectCompactionCandidate(
    context: IRequiredContext,
    checkpoint: ICompactionCheckpoint,
): IRequiredContext {
    assertCompactionCheckpoint(checkpoint)
    const previous = context.checkpoint
    const previousCount = previous?.compactedMessageCount ?? 0
    const count = checkpoint.compactedMessageCount - previousCount
    if (
        !Number.isSafeInteger(checkpoint.compactedMessageCount)
        || !Number.isSafeInteger(previousCount)
        || count < 0
        || count > eligibleCompactionEnd(context.messages)
        || (previous !== undefined && previous.sessionId !== checkpoint.sessionId)
        || context.messages.some((message) => message.sessionId !== checkpoint.sessionId)
    ) {
        throw new Error("Compaction candidate does not match its captured context")
    }
    if (count === 0) {
        if (previous?.throughMessageId !== checkpoint.throughMessageId) {
            throw new Error("Compaction candidate changed an unchanged boundary")
        }
    } else {
        assertCheckpointAnchor({ ...checkpoint, compactedMessageCount: count }, context.messages)
    }
    return {
        messages: context.messages.slice(count),
        contextSummary: checkpoint.summary,
        checkpoint,
    }
}
