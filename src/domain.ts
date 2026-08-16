interface IMessageBase {
    readonly id: string
    readonly sessionId: string
    readonly runId: string
    readonly createdAt: number
}

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

export interface IAssistantMessage extends IMessageBase {
    readonly role: "assistant"
    readonly content: readonly TAssistantContent[]
    readonly stopReason: string
    readonly errorMessage?: string
}

export interface IToolResultMessage extends IMessageBase {
    readonly role: "toolResult"
    readonly toolCallId: string
    readonly toolName: string
    readonly content: string
    readonly isError: boolean
}

export type TAgentMessage =
    | IUserMessage
    | IAssistantMessage
    | IToolResultMessage

export type TAgentRunEndReason =
    | "completed"
    | "aborted"
    | "error"
    | "internal-error"
    | "max-iterations"

export interface ISessionInfo {
    readonly id: string
    readonly agentId: string
    readonly title: string
    readonly createdAt: number
    readonly updatedAt: number
}


export interface ISessionSnapshot {
    readonly messages: readonly TAgentMessage[]
    readonly streamingMessage?: IAssistantMessage
    readonly isRunning: boolean
    readonly activeRunId?: string
    readonly pendingToolCallIds: readonly string[]
    readonly lastRunReason?: TAgentRunEndReason
    readonly errorMessage?: string
}
