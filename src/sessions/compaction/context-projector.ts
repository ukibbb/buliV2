import type {
    IAgentContextProjection,
    TAgentMessage,
} from "@/agent"
import {
    assertCheckpointAnchor,
    type ICompactionCheckpoint,
} from "@/sessions/compaction/checkpoint"

/** Projects durable history without changing or deleting its source messages. */
export function projectAgentContext(
    messages: readonly TAgentMessage[],
    checkpoint?: ICompactionCheckpoint,
): IAgentContextProjection {
    if (!checkpoint) return { messages: structuredClone(messages) }

    if (messages.some((message) => message.sessionId !== checkpoint.sessionId)) {
        throw new Error("Compaction checkpoint belongs to another session")
    }
    assertCheckpointAnchor(checkpoint, messages)
    return {
        messages: structuredClone(
            messages.slice(checkpoint.compactedMessageCount),
        ),
        contextSummary: checkpoint.summary,
    }
}
