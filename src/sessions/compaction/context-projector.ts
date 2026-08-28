import type {
    AgentContextProjection,
    AgentMessage,
} from "@/agent"
import {
    assertCheckpointAnchor,
    type ICompactionCheckpoint,
} from "@/sessions/compaction/checkpoint"
import {
    eligibleCompactionEnd,
    isStructuredCompactionSummary,
} from "@/sessions/compaction/session-compactor"

/** Projects durable history without changing or deleting its source messages. */
export function projectAgentContext(
    messages: readonly AgentMessage[],
    checkpoint?: ICompactionCheckpoint,
): AgentContextProjection {
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
    if (
        checkpoint.compactedMessageCount > safeCompactionEnd
        || !isStructuredCompactionSummary(checkpoint.summary)
    ) {
        return { messages: structuredClone(messages) }
    }
    return {
        messages: structuredClone(
            messages.slice(checkpoint.compactedMessageCount),
        ),
        contextSummary: checkpoint.summary,
    }
}
