import type { ModelProfile, ModelUsage } from "@/agent/model-values"
import type { ToolExecutionOutcome } from "@/agent/tool"

export const USER_PATH_REFERENCES_PER_MESSAGE_MAX = 50
export const USER_PATH_REFERENCES_PER_SESSION_MAX = 500
export const USER_IMAGE_ATTACHMENTS_MAX = 4
export const USER_IMAGE_MAX_BYTES = 5 * 1024 * 1024
export const USER_IMAGE_TOTAL_MAX_BYTES = 10 * 1024 * 1024

interface MessageBase {
    readonly id: string
    readonly sessionId: string
    readonly runId: string
    readonly createdAt: number
}

/** Identifies how user input entered an agent run. */
export type UserMessageSource = "prompt" | "steer" | "followUp"

export interface UserSourceText {
    readonly value: string
    readonly start: number
    readonly end: number
}

/** Grants read/glob access to one explicitly selected path capability. */
export interface UserPathReference {
    readonly type: "path"
    readonly kind: "file" | "directory"
    readonly path: string
    readonly source: UserSourceText
}

/** Provider-neutral image bytes attached directly to one user turn. */
export interface UserImageAttachment {
    readonly type: "image"
    readonly mimeType: string
    readonly data: string
    readonly filename: string
    readonly source: UserSourceText
}

export interface UserInputContent {
    readonly text: string
    readonly references?: readonly UserPathReference[]
    readonly attachments?: readonly UserImageAttachment[]
}

export type UserInput = string | UserInputContent

export interface UserMessage extends MessageBase {
    readonly role: "user"
    readonly content: string
    readonly source: UserMessageSource
    readonly references?: readonly UserPathReference[]
    readonly attachments?: readonly UserImageAttachment[]
}

export interface TextContent {
    readonly type: "text"
    readonly text: string
}

export interface ReasoningContent {
    readonly type: "reasoning"
    readonly text: string
}

export interface ToolCallContent {
    readonly type: "toolCall"
    readonly toolCallId: string
    readonly toolName: string
    readonly input: Record<string, unknown>
}

export type AssistantContent =
    | TextContent
    | ReasoningContent
    | ToolCallContent

/** Durable provider-neutral assistant response consumed by sessions and UI. */
export interface AssistantMessage extends MessageBase {
    readonly role: "assistant"
    readonly content: readonly AssistantContent[]
    readonly stopReason: string
    readonly errorMessage?: string
    readonly model?: ModelProfile
    readonly usage?: ModelUsage
}

/** Durable result paired with one tool call from an assistant message. */
export interface ToolResultMessage extends MessageBase {
    readonly role: "toolResult"
    readonly toolCallId: string
    readonly toolName: string
    readonly content: string
    readonly isError: boolean
    readonly outcome?: ToolExecutionOutcome
    readonly summary?: string
}

/** Complete provider-neutral message history owned by an agent. */
export type AgentMessage =
    | UserMessage
    | AssistantMessage
    | ToolResultMessage
