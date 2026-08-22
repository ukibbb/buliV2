import type { IModelProfile, IModelUsage } from "@/agent/model-values"
import type { TToolExecutionOutcome } from "@/agent/tool"

interface IMessageBase {
    readonly id: string
    readonly sessionId: string
    readonly runId: string
    readonly createdAt: number
}

/** Identifies how user input entered an agent run. */
export type TUserMessageSource = "prompt" | "steer" | "followUp"

export interface IUserMessage extends IMessageBase {
    readonly role: "user"
    readonly content: string
    readonly source: TUserMessageSource
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
    readonly toolCallId: string
    readonly toolName: string
    readonly content: string
    readonly isError: boolean
    readonly outcome?: TToolExecutionOutcome
    readonly summary?: string
}

/** Complete provider-neutral message history owned by an agent. */
export type TAgentMessage =
    | IUserMessage
    | IAssistantMessage
    | IToolResultMessage
