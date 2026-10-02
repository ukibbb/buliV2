import type {
    TAgentMessage,
    IModelProfile,
    IModelUsage,
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

type TCheckpointAnchor = Pick<ICompactionCheckpoint,
    "sessionId" | "compactedMessageCount" | "throughMessageId">

type TCheckpointMessage = { readonly id: string } & (
    | { readonly role: "user" }
    | { readonly role: "assistant"; readonly stopReason: string }
    | { readonly role: "toolResult"; readonly assistantMessageId: string; readonly toolCallId: string }
)

/** Verifies that a checkpoint ends on a complete anchored message sequence. */
export function assertCheckpointAnchor(
    checkpoint: ICompactionCheckpoint,
    messages: readonly TAgentMessage[],
): void {
    assertCheckpointReferences(checkpoint, messages, (message) => message.role === "assistant"
        ? message.content.flatMap((content) => content.type === "toolCall" ? [content.toolCallId] : [])
        : [])
}

/** Shared anchor rules for validated payloads and metadata; tool names/runs are not matched here. */
export function assertCheckpointReferences<TMessage extends TCheckpointMessage>(
    checkpoint: TCheckpointAnchor,
    messages: readonly TMessage[],
    toolCallIds: (message: TMessage) => readonly string[],
): void {
    const anchor = messages[checkpoint.compactedMessageCount - 1]
    if (
        anchor?.id !== checkpoint.throughMessageId
        || !hasCompleteToolSequence(
            messages.slice(0, checkpoint.compactedMessageCount), toolCallIds,
        )
    ) {
        throw new Error(
            `Compaction checkpoint does not match session ${checkpoint.sessionId}`,
        )
    }
}

function hasCompleteToolSequence<TMessage extends TCheckpointMessage>(
    messages: readonly TMessage[],
    toolCallIds: (message: TMessage) => readonly string[],
): boolean {
    let pending: { readonly assistantMessageId: string; readonly toolCallIds: Set<string> } | undefined
    for (const message of messages) {
        if (pending) {
            if (
                message.role !== "toolResult"
                || message.assistantMessageId !== pending.assistantMessageId
                || !pending.toolCallIds.delete(message.toolCallId)
            ) {
                return false
            }
            if (pending.toolCallIds.size === 0) pending = undefined
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

        const ids = toolCallIds(message)
        if (ids.length > 0) pending = { assistantMessageId: message.id, toolCallIds: new Set(ids) }
    }
    return pending === undefined
}
