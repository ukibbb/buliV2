export type TMessageRole = "user" | "assistant"

interface IMessageBase {
    readonly id: string
    readonly sessionId: string
    readonly role: TMessageRole
    readonly createdAt: number
}

export interface IUserMessage extends IMessageBase {
    readonly role: "user"
}

export interface IBuliMessage extends IMessageBase {
    readonly role: "assistant"
    readonly completedAt?: number
    readonly finish?: string
    readonly error?: {
        readonly name: string
        readonly message: string
    }
}

export type TMessage = IUserMessage | IBuliMessage

interface IPartBase {
    readonly id: string
    readonly messageId: string
    readonly sessionId: string
    readonly createdAt: number
}

export interface ITextPart extends IPartBase {
    readonly type: "text"
    readonly text: string
}

export interface IReasoningPart extends IPartBase {
    readonly type: "reasoning"
    readonly text: string
}

export type TJsonValue =
    | null
    | boolean
    | number
    | string
    | TJsonValue[]
    | TJsonObject

export type TJsonObject = { [key: string]: TJsonValue }

export type TToolStatus =
    | "pending"
    | "running"
    | "completed"
    | "error"
    | "cancelled"

export type TToolExecutionLocation = "local" | "provider"

export interface IToolPart extends IPartBase {
    readonly type: "tool"
    readonly callID: string
    readonly tool: string
    readonly status: TToolStatus
    readonly input: TJsonObject
    readonly output?: TJsonValue
    readonly error?: string
    readonly execution: TToolExecutionLocation
    readonly startedAt?: number
    readonly completedAt?: number
}

export type TPart = ITextPart | IReasoningPart | IToolPart

export interface IBuliMessageWithParts {
    readonly info: TMessage
    readonly parts: readonly TPart[]
}

export type TAgentRunEndReason =
    | "completed"
    | "aborted"
    | "error"
    | "max-iterations"

export interface ISessionSnapshot {
    readonly messages: readonly IBuliMessageWithParts[]
    readonly isRunning: boolean
    readonly pendingToolCallIDs: readonly string[]
    readonly lastRunReason?: TAgentRunEndReason
}
