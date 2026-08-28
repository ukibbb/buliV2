import type {
    TAgentMessage,
    IAssistantMessage,
    IToolResultMessage,
} from "@/agent"

/** Creates durable error results for tool calls left unmatched by an interrupted run. */
export function createInterruptedToolResults(
    messages: readonly TAgentMessage[],
): readonly IToolResultMessage[] {
    const messageIds = new Set(messages.map((message) => message.id))
    let pending: {
        assistant: IAssistantMessage
        remainingToolCallIds: Set<string>
    } | undefined

    for (const message of messages) {
        if (pending) {
            if (
                message.role === "toolResult"
                && message.runId === pending.assistant.runId
                && pending.remainingToolCallIds.delete(message.toolCallId)
            ) {
                if (pending.remainingToolCallIds.size === 0) pending = undefined
                continue
            }
            throw new Error(
                `Interrupted tool turn must be the final turn in session ${pending.assistant.sessionId}`,
            )
        }

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
        if (toolCallIds.length > 0) {
            pending = {
                assistant: message,
                remainingToolCallIds: new Set(toolCallIds),
            }
        }
    }

    if (!pending) return []

    return pending.assistant.content.flatMap((content) => {
        if (
            content.type !== "toolCall"
            || !pending.remainingToolCallIds.has(content.toolCallId)
        ) {
            return []
        }
        const idBase = `recovered-${pending.assistant.id}-${content.toolCallId}`
        let id = idBase
        let suffix = 1
        while (messageIds.has(id)) {
            id = `${idBase}-${suffix}`
            suffix += 1
        }
        messageIds.add(id)
        return [{
            id,
            sessionId: pending.assistant.sessionId,
            runId: pending.assistant.runId,
            role: "toolResult" as const,
            toolCallId: content.toolCallId,
            toolName: content.toolName,
            content: "A durable tool result was not recorded. The tool may have produced side effects; inspect the current state before retrying.",
            isError: true,
            outcome: "effects-unknown" as const,
            summary: "Tool outcome is unknown; inspect state before retrying",
            createdAt: pending.assistant.createdAt,
        }]
    })
}
