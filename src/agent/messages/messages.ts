import type { IModelProfile, IModelUsage } from "@/agent/model/model-values"
import type { TToolExecutionOutcome } from "@/agent/tools/tool"

export const USER_PATH_REFERENCES_PER_MESSAGE_MAX = 50
export const USER_PATH_REFERENCES_PER_SESSION_MAX = 500
export const USER_IMAGE_ATTACHMENTS_MAX = 4
export const USER_IMAGE_MAX_BYTES = 5 * 1024 * 1024
export const USER_IMAGE_TOTAL_MAX_BYTES = 10 * 1024 * 1024

interface IMessageBase {
    readonly id: string
    readonly sessionId: string
    readonly runId: string
    readonly createdAt: number
}

/** Identifies how user input entered an agent run. */
export type TUserMessageSource = "prompt" | "steer" | "followUp"

export interface IUserSourceText {
    readonly value: string
    readonly start: number
    readonly end: number
}

/** Records one path explicitly selected through the prompt editor. */
export interface IUserPathReference {
    readonly type: "path"
    readonly kind: "file" | "directory"
    readonly path: string
    readonly source: IUserSourceText
}

/** Provider-neutral image bytes attached directly to one user turn. */
export interface IUserImageAttachment {
    readonly type: "image"
    readonly mimeType: string
    readonly data: string
    readonly filename: string
    readonly source: IUserSourceText
}

export interface IUserInputContent {
    readonly text: string
    readonly references?: readonly IUserPathReference[]
    readonly attachments?: readonly IUserImageAttachment[]
}

export type TUserInput = string | IUserInputContent

export interface IUserMessage extends IMessageBase {
    readonly role: "user"
    readonly content: string
    //  "prompt" | "steer" | "followUp"
    readonly source: TUserMessageSource
    //
    readonly references?: readonly IUserPathReference[]
    readonly attachments?: readonly IUserImageAttachment[]
    /** Added by hooks: sent to the model, not shown as the user's text. */
    readonly hookContext?: string
}

export interface ITextContent {
    readonly type: "text"
    readonly text: string
}

export interface IReasoningContent {
    readonly type: "reasoning"
    readonly text: string
}

export interface IToolCallContent {
    readonly type: "toolCall"
    readonly toolCallId: string
    readonly toolName: string
    readonly input: Record<string, unknown>
}

export type TAssistantContent =
    | ITextContent
    | IReasoningContent
    | IToolCallContent

/** Durable provider-neutral assistant response consumed by sessions and UI. */
export interface IAssistantMessage extends IMessageBase {
    readonly role: "assistant"
    readonly content: readonly TAssistantContent[]
    readonly stopReason: string
    readonly errorMessage?: string
    readonly model?: IModelProfile
    readonly usage?: IModelUsage
}

/** Durable result paired with one tool call from an assistant message. */
export interface IToolResultMessage extends IMessageBase {
    readonly role: "toolResult"
    readonly assistantMessageId: string
    readonly toolCallId: string
    readonly toolName: string
    readonly content: string
    readonly isError: boolean
    readonly outcome?: TToolExecutionOutcome
    readonly summary?: string
    readonly diff?: string
    /** Added by hooks: sent to the model after the tool output. */
    readonly hookContext?: string
}

/** One durable provider-neutral conversation message. */
export type TAgentMessage =
    | IUserMessage
    | IAssistantMessage
    | IToolResultMessage

/** The message as the model receives it: hook context follows the content as a system reminder. */
export function withHookContextInContent(message: TAgentMessage): TAgentMessage {
    if (message.role === "assistant" || message.hookContext === undefined) return message
    const { hookContext, ...rest } = message
    return { ...rest, content: `${message.content}\n\n<system-reminder>\n${hookContext}\n</system-reminder>` }
}
