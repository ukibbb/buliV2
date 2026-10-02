import type {
    TAgentMessage,
    IAssistantMessage,
    IToolCallContent,
    IToolResultMessage,
} from "@/agent"

export const EMPTY_TOOL_RESULTS: ReadonlyMap<string, IToolResultMessage> = new Map()
export const EMPTY_TOOL_CALL_IDS: ReadonlySet<string> = new Set()

export interface IToolActivityProjection {
    readonly resultsByAssistantMessageId: ReadonlyMap<string, ReadonlyMap<string, IToolResultMessage>>
    readonly matchedToolResultMessageIds: ReadonlySet<string>
    readonly activeAssistantMessageId?: string
    readonly activeToolCallIds: ReadonlySet<string>
}

interface IOpenToolBatch {
    readonly message: IAssistantMessage
    readonly callsById: Map<string, IToolCallContent>
}

/** Matches tool results within assistant batches and identifies the active batch. */
export function projectToolActivities(
    messages: readonly TAgentMessage[],
    activeRunId: string | undefined,
): IToolActivityProjection {
    const resultsByAssistantMessageId = new Map<string, Map<string, IToolResultMessage>>()
    const matchedToolResultMessageIds = new Set<string>()
    let openBatch: IOpenToolBatch | undefined

    for (const message of messages) {
        if (message.role === "toolResult") {
            if (!openBatch || !belongsToBatch(message, openBatch)) continue
            const call = openBatch.callsById.get(message.toolCallId)
            if (!call || call.toolName !== message.toolName) continue

            let results = resultsByAssistantMessageId.get(openBatch.message.id)
            if (!results) {
                results = new Map()
                resultsByAssistantMessageId.set(openBatch.message.id, results)
            }
            results.set(message.toolCallId, message)
            matchedToolResultMessageIds.add(message.id)
            openBatch.callsById.delete(message.toolCallId)
            continue
        }

        openBatch = undefined
        if (message.role !== "assistant") continue
        if (message.stopReason === "aborted" || message.stopReason === "error") continue
        const calls = message.content.filter(
            (content): content is IToolCallContent => content.type === "toolCall",
        )
        if (calls.length === 0) continue
        openBatch = {
            message,
            callsById: new Map(calls.map((call) => [call.toolCallId, call])),
        }
    }

    const active = openBatch?.message.runId === activeRunId ? openBatch : undefined
    return {
        resultsByAssistantMessageId,
        matchedToolResultMessageIds,
        ...(active === undefined ? {} : { activeAssistantMessageId: active.message.id }),
        activeToolCallIds: active === undefined
            ? EMPTY_TOOL_CALL_IDS
            : new Set(active.callsById.keys()),
    }
}

export function toolCallIds(message: IAssistantMessage): ReadonlySet<string> {
    return new Set(message.content.flatMap((content) =>
        content.type === "toolCall" ? [content.toolCallId] : []
    ))
}

function belongsToBatch(result: IToolResultMessage, batch: IOpenToolBatch): boolean {
    return result.assistantMessageId === batch.message.id
        && result.sessionId === batch.message.sessionId
        && result.runId === batch.message.runId
}
