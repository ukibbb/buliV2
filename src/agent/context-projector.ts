import type { IAgentContextProjection } from "@/agent/agent-types"
import type {
    ICompactionCheckpoint,
    TAgentMessage,
} from "@/domain"
import { assertCheckpointAnchor } from "@/session/session-manager"

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
