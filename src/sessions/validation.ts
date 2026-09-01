import { Buffer } from "node:buffer"
import { isAbsolute } from "node:path"

import type {
    TAgentMessage,
    IAssistantMessage,
    IFileChangeProposalRecord,
    TToolExecutionOutcome,
} from "@/agent"
import {
    isValidUserImage,
    USER_IMAGE_ATTACHMENTS_MAX,
    USER_IMAGE_MAX_BYTES,
    USER_IMAGE_TOTAL_MAX_BYTES,
    USER_PATH_REFERENCES_PER_MESSAGE_MAX,
} from "@/agent"
import { displayTextSlice } from "@/common/display-text"
import type { ICompactionCheckpoint } from "@/sessions/compaction/checkpoint"
import type { ISessionInfo } from "@/sessions/repository"

const USER_IMAGE_MIME_TYPES = new Set([
    "image/gif",
    "image/jpeg",
    "image/png",
    "image/webp",
])

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

/** Asserts that a value is an exact durable file-change proposal. */
export function assertFileChangeProposalRecord(
    value: unknown,
): asserts value is IFileChangeProposalRecord {
    if (
        !isRecord(value)
        || !hasExactKeys(value, [
            "id",
            "sessionId",
            "runId",
            "toolCallId",
            "operation",
            "path",
            "diff",
            "status",
            "createdAt",
            ...(value.resolvedAt === undefined ? [] : ["resolvedAt"]),
        ])
        || typeof value.id !== "string"
        || value.id.trim().length === 0
        || typeof value.sessionId !== "string"
        || value.sessionId.trim().length === 0
        || typeof value.runId !== "string"
        || value.runId.trim().length === 0
        || typeof value.toolCallId !== "string"
        || value.toolCallId.trim().length === 0
        || (value.operation !== "edit" && value.operation !== "write")
        || typeof value.path !== "string"
        || value.path.trim().length === 0
        || typeof value.diff !== "string"
        || value.diff.length === 0
        || !isFileChangeProposalStatus(value.status)
        || typeof value.createdAt !== "number"
        || !Number.isFinite(value.createdAt)
        || (
            value.status === "pending"
                ? value.resolvedAt !== undefined
                : typeof value.resolvedAt !== "number"
                    || !Number.isFinite(value.resolvedAt)
                    || value.resolvedAt < value.createdAt
        )
    ) {
        throw new Error("Invalid file-change proposal")
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
                    ...(value.references === undefined ? [] : ["references"]),
                    ...(value.attachments === undefined ? [] : ["attachments"]),
                    "createdAt",
                ])
                || typeof value.content !== "string"
                || (
                    value.content.trim().length === 0
                    && (!Array.isArray(value.attachments) || value.attachments.length === 0)
                )
                || (
                    value.source !== "prompt"
                    && value.source !== "steer"
                    && value.source !== "followUp"
                )
            ) {
                throw new Error("Invalid user message")
            }
            assertUserPathReferences(value.references, value.content)
            assertUserImageAttachments(value.attachments, value.content)
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

function assertUserPathReferences(value: unknown, content: string): void {
    if (value === undefined) return
    if (
        !Array.isArray(value)
        || value.length === 0
        || value.length > USER_PATH_REFERENCES_PER_MESSAGE_MAX
    ) {
        throw new Error("Invalid user path references")
    }
    for (const reference of value) {
        if (
            !isRecord(reference)
            || !hasExactKeys(reference, ["type", "kind", "path", "source"])
            || reference.type !== "path"
            || (reference.kind !== "file" && reference.kind !== "directory")
            || typeof reference.path !== "string"
            || !isAbsolute(reference.path)
        ) throw new Error("Invalid user path reference")
        assertUserSourceText(reference.source, content)
    }
}

function assertUserImageAttachments(value: unknown, content: string): void {
    if (value === undefined) return
    if (
        !Array.isArray(value)
        || value.length === 0
        || value.length > USER_IMAGE_ATTACHMENTS_MAX
    ) {
        throw new Error("Invalid user image attachments")
    }
    let totalBytes = 0
    for (const attachment of value) {
        if (
            !isRecord(attachment)
            || !hasExactKeys(attachment, [
                "type",
                "mimeType",
                "data",
                "filename",
                "source",
            ])
            || attachment.type !== "image"
            || typeof attachment.mimeType !== "string"
            || !USER_IMAGE_MIME_TYPES.has(attachment.mimeType)
            || typeof attachment.filename !== "string"
            || attachment.filename.trim().length === 0
            || typeof attachment.data !== "string"
        ) throw new Error("Invalid user image attachment")
        const bytes = decodeBase64Image(attachment.data)
        totalBytes += bytes.byteLength
        if (
            totalBytes > USER_IMAGE_TOTAL_MAX_BYTES
            || !isValidUserImage(attachment.mimeType, bytes)
        ) {
            throw new Error("Invalid user image attachment")
        }
        assertUserSourceText(attachment.source, content)
    }
}

function assertUserSourceText(value: unknown, content: string): void {
    if (
        !isRecord(value)
        || !hasExactKeys(value, ["value", "start", "end"])
        || typeof value.value !== "string"
        || value.value.length === 0
        || !Number.isSafeInteger(value.start)
        || Number(value.start) < 0
        || !Number.isSafeInteger(value.end)
        || Number(value.end) <= Number(value.start)
    ) throw new Error("Invalid user resource source")
    if (
        displayTextSlice(content, Number(value.start), Number(value.end))
        !== value.value
    ) throw new Error("User resource source does not match message content")
}

function decodeBase64Image(data: string): Uint8Array {
    if (
        data.length === 0
        || data.length > Math.ceil(USER_IMAGE_MAX_BYTES / 3) * 4
        || data.length % 4 !== 0
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)
    ) throw new Error("Invalid user image attachment")
    const bytes = Buffer.from(data, "base64")
    if (
        bytes.byteLength === 0
        || bytes.byteLength > USER_IMAGE_MAX_BYTES
        || bytes.toString("base64") !== data
    ) throw new Error("Invalid user image attachment")
    return bytes
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

function isFileChangeProposalStatus(value: unknown): boolean {
    return value === "pending"
        || value === "applied"
        || value === "rejected"
        || value === "expired"
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
