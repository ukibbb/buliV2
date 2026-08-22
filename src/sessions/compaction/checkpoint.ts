import type {
    IModelProfile,
    IModelUsage,
    TAgentMessage,
} from "@/agent"

/** Durable summary replacing a compacted prefix of session messages. */
export interface ICompactionCheckpoint {
    readonly id: string
    readonly sessionId: string
    readonly createdAt: number
    readonly reason: "manual" | "automatic"
    readonly compactedMessageCount: number
    readonly throughMessageId: string
    readonly summary: string
    readonly model?: IModelProfile
    readonly usage?: IModelUsage
}

/** Verifies that a checkpoint ends on a complete anchored message sequence. */
export function assertCheckpointAnchor(
    checkpoint: ICompactionCheckpoint,
    messages: readonly TAgentMessage[],
): void {
    const anchor = messages[checkpoint.compactedMessageCount - 1]
    if (
        anchor?.id !== checkpoint.throughMessageId
        || !hasCompleteToolSequence(
            messages.slice(0, checkpoint.compactedMessageCount),
        )
    ) {
        throw new Error(
            `Compaction checkpoint does not match session ${checkpoint.sessionId}`,
        )
    }
}

function hasCompleteToolSequence(messages: readonly TAgentMessage[]): boolean {
    let pendingToolCallIds: Set<string> | undefined
    for (const message of messages) {
        if (pendingToolCallIds) {
            if (
                message.role !== "toolResult"
                || !pendingToolCallIds.delete(message.toolCallId)
            ) {
                return false
            }
            if (pendingToolCallIds.size === 0) pendingToolCallIds = undefined
            continue
        }
        if (message.role === "toolResult") return false
        if (
            message.role !== "assistant"
            || message.stopReason === "aborted"
            || message.stopReason === "error"
        ) {
            continue
        }

        const toolCallIds = message.content.flatMap((content) =>
            content.type === "toolCall" ? [content.toolCallId] : []
        )
        if (toolCallIds.length > 0) pendingToolCallIds = new Set(toolCallIds)
    }
    return pendingToolCallIds === undefined
}
