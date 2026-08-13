interface IMessageBase {
  readonly id: string
  readonly sessionId: string
  readonly createdAt: number
}

export interface IUserMessage extends IMessageBase {
  readonly role: "user"
  readonly content: string
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
  | "max-iterations"

export interface ISessionSnapshot {
  readonly messages: readonly TAgentMessage[]
  readonly streamingMessage?: IAssistantMessage
  readonly isRunning: boolean
  readonly pendingToolCallIds: readonly string[]
  readonly lastRunReason?: TAgentRunEndReason
}
