import { streamOpenAiTextWithAuth } from "@/providers/openai/transport"

type TMessageRole = "user" | "assistant"

interface IMessageBase {
  id: string
  sessionId: string
  role: TMessageRole
  createdAt: number
}

export interface IBuliMessage extends IMessageBase {
  role: "assistant"
}


// interface can describe only objects
// types can descript primitives, tuples, functions
interface PartBase {
  id: string
  messageId: string
  sessionId: string
  createdAt: number
}


interface TextPart extends PartBase {

}
export type Part = TextPart

interface IBuliMessageWithParts {
  info: IBuliMessage
  parts: Part[]
}


interface IUserInteractionRequest {
  sessionId: string
  history: IBuliMessageWithParts[]
}


type IInteractionEvent =
  | { type: "text-start", id: string }
  | { type: "text-delta", id: string }
  | { type: "text-end", id: string }
  | { type: "reasoning-start", id: string }
  | { type: "reasoning-delta", id: string }
  | { type: "reasoning-end", id: string }

export interface IUserBuliInteractionDriver {
  interaction(request: IUserInteractionRequest): Promise<AsyncIterable<IInteractionEvent>>
}





export class OpenAiUserBuliInteractionDriver implements IUserBuliInteractionDriver {
  async *interaction(request: IUserInteractionRequest): Promise<AsyncIterable<IInteractionEvent>> {
    streamOpenAiTextWithAuth()

  }
}
