/** Provider-neutral session records shared by the engine, application, and TUI. */
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

interface PartBase {
  readonly id: string
  readonly messageId: string
  readonly sessionId: string
  readonly createdAt: number
}

export interface TextPart extends PartBase {
  readonly type: "text"
  readonly text: string
}

export interface ReasoningPart extends PartBase {
  readonly type: "reasoning"
  readonly text: string
}

export type Part = TextPart | ReasoningPart

export interface IBuliMessageWithParts {
  readonly info: TMessage
  readonly parts: readonly Part[]
}

export interface ISessionSnapshot {
  readonly messages: readonly IBuliMessageWithParts[]
}
