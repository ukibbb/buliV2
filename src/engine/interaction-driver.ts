import type {
  IBuliMessageWithParts,
  TJsonObject,
  TJsonValue,
  TToolExecutionLocation,
} from "@/domain"

export interface IBuliUserInteractionRequest {
  sessionId: string
  history: readonly IBuliMessageWithParts[]
  signal: AbortSignal
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
  | {
      type: "tool-call"
      callID: string
      tool: string
      input: TJsonObject
      execution: TToolExecutionLocation
    }
  | {
      type: "tool-result"
      callID: string
      tool: string
      input: TJsonObject
      output: TJsonValue
      execution: TToolExecutionLocation
    }
  | {
      type: "tool-error"
      callID: string
      tool: string
      input: TJsonObject
      error: string
      execution: TToolExecutionLocation
    }

export interface IUserBuliInteractionDriver {
  interaction(
    request: IBuliUserInteractionRequest,
  ): AsyncIterable<IInteractionEvent>
}
