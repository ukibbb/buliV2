
type TMessageRole = "user" | "assistant"

interface IMessageBase {
  id: string
  sessionId: string
  role: TMessageRole
  createdAt: number
}

export interface IUserMessage extends IMessageBase {
  role: "user"
}

export interface IBuliMessage extends IMessageBase {
  role: "assistant"
  completedAt?: number
  finish?: string
  error?: {
    name: string
    message: string

  }

}

export type TMessage = IUserMessage | IBuliMessage


// interface can describe only objects
// types can descript primitives, tuples, functions
interface PartBase {
  id: string
  messageId: string
  sessionId: string
  createdAt: number
}


export interface TextPart extends PartBase {
  type: "text"
  text: string
}

interface ReasoningPart extends PartBase {
  type: "reasoning",
  text: string
}

export type Part = TextPart | ReasoningPart

export interface IBuliMessageWithParts {
  info: TMessage
  parts: Part[]
}

export interface IBuliUserInteractionRequest {
  sessionId: string
  history: IBuliMessageWithParts[]
}


export type IInteractionEvent =
  | { type: "text-start"; id: string }
  | { type: "text-delta"; id: string; delta: string }
  | { type: "text-end"; id: string }
  | { type: "reasoning-start"; id: string }
  | { type: "reasoning-delta"; id: string; delta: string }
  | { type: "reasoning-end"; id: string }
  | { type: "finish"; reason: string }
  | { type: "abort"; reason?: string }
  | { type: "error"; error: Error }

export interface IInteractionState {

}

// put somewhere else
export interface IUserBuliInteractionDriver {
  interaction(request: IBuliUserInteractionRequest): AsyncIterable<IInteractionEvent>
}
