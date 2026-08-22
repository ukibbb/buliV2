import type {
    IAssistantMessage,
    TAgentMessage,
    TToolExecutionOutcome,
} from "@/agent"
import type { ICompactionCheckpoint } from "@/sessions/compaction/checkpoint"
import type { ISessionInfo } from "@/sessions/repository"

/** Asserts that a value is an exact durable compaction checkpoint. */
export function assertCompactionCheckpoint(
    value: unknown,
): asserts value is ICompactionCheckpoint {
    if (
        !isRecord(value)
        || !hasExactKeys(value, [
            "id",
            "sessionId",
            "createdAt",
            "reason",
            "compactedMessageCount",
            "throughMessageId",
            "summary",
            ...(value.model === undefined ? [] : ["model"]),
            ...(value.usage === undefined ? [] : ["usage"]),
        ])
        || typeof value.id !== "string"
        || value.id.trim().length === 0
        || typeof value.sessionId !== "string"
        || value.sessionId.trim().length === 0
        || typeof value.createdAt !== "number"
        || !Number.isFinite(value.createdAt)
        || (value.reason !== "manual" && value.reason !== "automatic")
        || !isNonNegativeInteger(value.compactedMessageCount, false)
        || typeof value.throughMessageId !== "string"
        || value.throughMessageId.trim().length === 0
        || typeof value.summary !== "string"
        || value.summary.trim().length === 0
    ) {
        throw new Error("Invalid compaction checkpoint")
    }
    if (value.model !== undefined) assertModelProfile(value.model)
    if (value.usage !== undefined) assertModelUsage(value.usage)
}

/** Asserts that a value contains reopenable durable session metadata. */
export function assertSessionInfo(
    value: unknown,
): asserts value is ISessionInfo {
    if (
        !isRecord(value)
        || typeof value.id !== "string"
        || value.id.trim().length === 0
        || typeof value.agentId !== "string"
        || value.agentId.trim().length === 0
        || typeof value.title !== "string"
        || value.title.trim().length === 0
        || typeof value.createdAt !== "number"
        || !Number.isFinite(value.createdAt)
        || typeof value.updatedAt !== "number"
        || !Number.isFinite(value.updatedAt)
        || value.updatedAt < value.createdAt
    ) {
        throw new Error("Invalid session metadata")
    }
}

/** Asserts that a value is a complete provider-neutral session message. */
export function assertDurableSessionMessage(
    value: unknown,
): asserts value is TAgentMessage {
    if (!isMessageBase(value)) throw new Error("Invalid session message")

    switch (value.role) {
        case "user":
            if (
                !hasExactKeys(value, [
                    "id",
                    "sessionId",
                    "runId",
                    "role",
                    "source",
                    "content",
                    "createdAt",
                ])
                || typeof value.content !== "string"
                || value.content.trim().length === 0
                || (
                    value.source !== "prompt"
                    && value.source !== "steer"
                    && value.source !== "followUp"
                )
            ) {
                throw new Error("Invalid user message")
            }
            return
        case "assistant":
            if (!hasExactKeys(value, [
                "id",
                "sessionId",
                "runId",
                "role",
                "content",
                "stopReason",
                "createdAt",
                ...(value.errorMessage === undefined ? [] : ["errorMessage"]),
                ...(value.model === undefined ? [] : ["model"]),
                ...(value.usage === undefined ? [] : ["usage"]),
            ])) {
                throw new Error("Invalid assistant message")
            }
            assertAssistantMessage(value)
            if (value.stopReason === "pending") {
                throw new Error("Cannot persist an incomplete assistant message")
            }
            return
        case "toolResult":
            if (
                !hasExactKeys(value, [
                    "id",
                    "sessionId",
                    "runId",
                    "role",
                    "toolCallId",
                    "toolName",
                    "content",
                    "isError",
                    ...(value.outcome === undefined ? [] : ["outcome"]),
                    ...(value.summary === undefined ? [] : ["summary"]),
                    "createdAt",
                ])
                || typeof value.toolCallId !== "string"
                || value.toolCallId.trim().length === 0
                || typeof value.toolName !== "string"
                || value.toolName.trim().length === 0
                || typeof value.content !== "string"
                || typeof value.isError !== "boolean"
                || (
                    value.outcome !== undefined
                    && !isToolExecutionOutcome(value.outcome)
                )
                || (
                    isToolExecutionOutcome(value.outcome)
                    && value.isError !== isErrorOutcome(value.outcome)
                )
                || (
                    value.summary !== undefined
                    && typeof value.summary !== "string"
                )
            ) {
                throw new Error("Invalid tool result message")
            }
            return
        default:
            throw new Error("Unknown session message role")
    }
}

function assertAssistantMessage(
    message: Record<string, unknown>,
): asserts message is Record<string, unknown> & IAssistantMessage {
    if (
        !Array.isArray(message.content)
        || typeof message.stopReason !== "string"
        || message.stopReason.trim().length === 0
    ) {
        throw new Error("Invalid assistant message")
    }
    if (
        message.errorMessage !== undefined
        && typeof message.errorMessage !== "string"
    ) {
        throw new Error("Invalid assistant error")
    }
    if (message.model !== undefined) assertModelProfile(message.model)
    if (message.usage !== undefined) assertModelUsage(message.usage)

    const toolCallIds = new Set<string>()
    for (const content of message.content) {
        if (!isRecord(content)) throw new Error("Invalid assistant content")
        if (content.type === "text" || content.type === "reasoning") {
            if (
                !hasExactKeys(content, ["type", "text"])
                || typeof content.text !== "string"
            ) {
                throw new Error("Invalid assistant text content")
            }
            continue
        }
        if (
            content.type !== "toolCall"
            || !hasExactKeys(content, [
                "type",
                "toolCallId",
                "toolName",
                "input",
            ])
            || typeof content.toolCallId !== "string"
            || content.toolCallId.trim().length === 0
            || toolCallIds.has(content.toolCallId)
            || typeof content.toolName !== "string"
            || content.toolName.trim().length === 0
            || !isJsonObject(content.input)
        ) {
            throw new Error("Invalid assistant tool call")
        }
        toolCallIds.add(content.toolCallId)
    }
}

function assertModelProfile(value: unknown): void {
    if (
        !isRecord(value)
        || !hasExactKeys(value, [
            "providerId",
            "modelId",
            ...(value.contextWindowTokens === undefined
                ? []
                : ["contextWindowTokens"]),
        ])
        || typeof value.providerId !== "string"
        || value.providerId.trim().length === 0
        || typeof value.modelId !== "string"
        || value.modelId.trim().length === 0
        || (
            value.contextWindowTokens !== undefined
            && !isNonNegativeInteger(value.contextWindowTokens, false)
        )
    ) {
        throw new Error("Invalid assistant model profile")
    }
}

function assertModelUsage(value: unknown): void {
    const usageKeys = [
        "inputTokens",
        "outputTokens",
        "totalTokens",
        "cacheReadTokens",
        "cacheWriteTokens",
        "reasoningTokens",
    ] as const
    if (
        !isRecord(value)
        || Object.keys(value).length === 0
        || Object.keys(value).some((key) => !usageKeys.includes(
            key as typeof usageKeys[number],
        ))
        || Object.values(value).some((tokens) =>
            !isNonNegativeInteger(tokens, true)
        )
    ) {
        throw new Error("Invalid assistant model usage")
    }
}

function isNonNegativeInteger(value: unknown, allowZero: boolean): boolean {
    return typeof value === "number"
        && Number.isSafeInteger(value)
        && (allowZero ? value >= 0 : value > 0)
}

function isToolExecutionOutcome(value: unknown): value is TToolExecutionOutcome {
    return value === "completed"
        || value === "rejected"
        || value === "manual"
        || value === "failed"
        || value === "committed-after-abort"
        || value === "effects-unknown"
}

function isErrorOutcome(outcome: TToolExecutionOutcome): boolean {
    return outcome === "failed"
        || outcome === "committed-after-abort"
        || outcome === "effects-unknown"
}

function isMessageBase(value: unknown): value is Record<string, unknown> & {
    readonly id: string
    readonly sessionId: string
    readonly runId: string
    readonly role: string
    readonly createdAt: number
} {
    return isRecord(value)
        && typeof value.id === "string"
        && value.id.trim().length > 0
        && typeof value.sessionId === "string"
        && value.sessionId.trim().length > 0
        && typeof value.runId === "string"
        && value.runId.trim().length > 0
        && typeof value.role === "string"
        && typeof value.createdAt === "number"
        && Number.isFinite(value.createdAt)
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
    return isJsonObjectValue(value, new Set())
}

function isJsonValue(value: unknown, ancestors: Set<object>): boolean {
    if (
        value === null
        || typeof value === "string"
        || typeof value === "boolean"
    ) {
        return true
    }
    if (typeof value === "number") return Number.isFinite(value)
    if (Array.isArray(value)) {
        if (
            ancestors.has(value)
            || Object.keys(value).length !== value.length
            || Reflect.ownKeys(value).length !== value.length + 1
        ) {
            return false
        }
        for (let index = 0; index < value.length; index += 1) {
            if (!Object.hasOwn(value, index)) return false
        }
        ancestors.add(value)
        const valid = value.every((item) => isJsonValue(item, ancestors))
        ancestors.delete(value)
        return valid
    }
    return isJsonObjectValue(value, ancestors)
}

function isJsonObjectValue(
    value: unknown,
    ancestors: Set<object>,
): value is Record<string, unknown> {
    if (!isRecord(value) || ancestors.has(value)) return false
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return false
    if (Reflect.ownKeys(value).length !== Object.keys(value).length) return false

    ancestors.add(value)
    const valid = Object.values(value).every((item) =>
        isJsonValue(item, ancestors)
    )
    ancestors.delete(value)
    return valid
}

function hasExactKeys(
    value: Record<string, unknown>,
    keys: readonly string[],
): boolean {
    const actual = Object.keys(value)
    return actual.length === keys.length
        && keys.every((key) => Object.hasOwn(value, key))
}
