import type { IBuliMessageWithParts } from "@/domain"

export interface IBuliUserInteractionRequest {
  sessionId: string
  history: readonly IBuliMessageWithParts[]
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
  | { type: "error"; error: unknown }

export interface IUserBuliInteractionDriver {
  interaction(
    request: IBuliUserInteractionRequest,
  ): AsyncIterable<IInteractionEvent>
}
