import type {
    IAssistantMessage,
    ICompactionCheckpoint,
    ISessionInfo,
    ISessionSnapshot,
    IToolResultMessage,
    TAgentMessage,
    TToolExecutionOutcome,
} from "@/domain"

export interface ISessionManager {
    readonly createSession: (info: ISessionInfo) => void
    readonly getSessionInfo: (sessionId: string) => ISessionInfo | undefined
    readonly listSessions: () => readonly ISessionInfo[]
    readonly getMessages: (sessionId: string) => readonly TAgentMessage[]
    readonly appendMessage: (message: TAgentMessage) => void
    readonly getCompactionCheckpoint: (
        sessionId: string,
    ) => ICompactionCheckpoint | undefined
    readonly saveCompactionCheckpoint: (
        checkpoint: ICompactionCheckpoint,
    ) => void
    readonly clearSession: (sessionId: string) => void
    readonly deleteSession: (sessionId: string) => void
    // Manager może posiadać zasoby storage. Runtime zwalnia je dopiero po zamknięciu
    // wszystkich sesji, które nadal mogą wykonywać ostatnie zapisy.
    readonly dispose?: () => void | Promise<void>
}

type TSessionId = string

/** Keeps durable messages separate from live Agent state. */
export class InMemorySessionManager implements ISessionManager {
    private readonly sessionsById = new Map<TSessionId, ISessionInfo>()
    private readonly messagesBySession = new Map<
        TSessionId,
        readonly TAgentMessage[]
    >()
    private readonly checkpointsBySession = new Map<
        TSessionId,
        ICompactionCheckpoint
    >()

    readonly createSession = (info: ISessionInfo): void => {
        assertSessionInfo(info)
        if (this.sessionsById.has(info.id)) {
            throw new Error(`Session already exists: ${info.id}`)
        }

        this.sessionsById.set(info.id, structuredClone(info))
    }

    readonly getSessionInfo = (sessionId: string): ISessionInfo | undefined => {
        const info = this.sessionsById.get(sessionId)
        return info === undefined ? undefined : structuredClone(info)
    }

    readonly listSessions = (): readonly ISessionInfo[] => {
        return structuredClone([...this.sessionsById.values()])
    }

    readonly getMessages = (sessionId: string): readonly TAgentMessage[] => {
        return structuredClone(this.messagesBySession.get(sessionId) ?? [])
    }

    readonly appendMessage = (message: TAgentMessage): void => {
        assertDurableSessionMessage(message)

        const info = this.sessionsById.get(message.sessionId)
        if (!info) {
            throw new Error(`Session does not exist: ${message.sessionId}`)
        }

        const current = this.messagesBySession.get(message.sessionId) ?? []
        const existingIndex = current.findIndex(
            (candidate) => candidate.id === message.id,
        )
        const updated = [...current]

        if (existingIndex === -1) updated.push(structuredClone(message))
        else updated[existingIndex] = structuredClone(message)

        this.messagesBySession.set(message.sessionId, updated)
        this.sessionsById.set(message.sessionId, {
            ...info,
            updatedAt: Math.max(info.updatedAt, message.createdAt),
        })
    }

    readonly getCompactionCheckpoint = (
        sessionId: string,
    ): ICompactionCheckpoint | undefined => {
        const checkpoint = this.checkpointsBySession.get(sessionId)
        return checkpoint === undefined
            ? undefined
            : structuredClone(checkpoint)
    }

    readonly saveCompactionCheckpoint = (
        checkpoint: ICompactionCheckpoint,
    ): void => {
        assertCompactionCheckpoint(checkpoint)
        if (!this.sessionsById.has(checkpoint.sessionId)) {
            throw new Error(`Session does not exist: ${checkpoint.sessionId}`)
        }
        assertCheckpointAnchor(
            checkpoint,
            this.messagesBySession.get(checkpoint.sessionId) ?? [],
        )
        this.checkpointsBySession.set(
            checkpoint.sessionId,
            structuredClone(checkpoint),
        )
    }

    readonly clearSession = (sessionId: string): void => {
        this.messagesBySession.delete(sessionId)
        this.checkpointsBySession.delete(sessionId)
    }

    readonly deleteSession = (sessionId: string): void => {
        this.sessionsById.delete(sessionId)
        this.messagesBySession.delete(sessionId)
        this.checkpointsBySession.delete(sessionId)
    }

    getAllMessages(): readonly TAgentMessage[] {
        return structuredClone([...this.messagesBySession.values()].flat())
    }
}

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

export function freezeSessionSnapshot(
    snapshot: ISessionSnapshot,
): ISessionSnapshot {
    const clone = structuredClone(snapshot)
    deepFreeze(clone)
    return clone
}

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

function deepFreeze(value: unknown): void {
    if (value === null || typeof value !== "object") return
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
}
