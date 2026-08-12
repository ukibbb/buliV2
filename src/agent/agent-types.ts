import type {
  IBuliMessageWithParts,
  TAgentRunEndReason,
  TJsonObject,
  TJsonValue,
  TToolExecutionLocation,
} from "@/domain"

export interface IAgentToolDescriptor {
  readonly name: string
  readonly description: string
  readonly inputSchema: TJsonObject
}

export interface IAgentToolExecutionContext {
  readonly toolCallID: string
  readonly signal: AbortSignal
}

export interface IAgentTool extends IAgentToolDescriptor {
  readonly execute: (
    input: TJsonObject,
    context: IAgentToolExecutionContext,
  ) => Promise<TJsonValue>
}

export interface IAgentModelRequest {
  readonly sessionId: string
  readonly systemPrompt: string
  readonly history: readonly IBuliMessageWithParts[]
  readonly tools: readonly IAgentToolDescriptor[]
  readonly signal: AbortSignal
}

export type IAgentModelEvent =
  | { readonly type: "text-start"; readonly id: string }
  | { readonly type: "text-delta"; readonly id: string; readonly delta: string }
  | { readonly type: "text-end"; readonly id: string }
  | { readonly type: "reasoning-start"; readonly id: string }
  | {
      readonly type: "reasoning-delta"
      readonly id: string
      readonly delta: string
    }
  | { readonly type: "reasoning-end"; readonly id: string }
  | {
      readonly type: "tool-call"
      readonly callID: string
      readonly tool: string
      readonly input: TJsonObject
      readonly execution: TToolExecutionLocation
    }
  | {
      readonly type: "tool-result"
      readonly callID: string
      readonly tool: string
      readonly input: TJsonObject
      readonly output: TJsonValue
      readonly execution: TToolExecutionLocation
    }
  | {
      readonly type: "tool-error"
      readonly callID: string
      readonly tool: string
      readonly input: TJsonObject
      readonly error: string
      readonly execution: TToolExecutionLocation
    }
  | { readonly type: "finish"; readonly reason: string }
  | { readonly type: "abort"; readonly reason?: string }
  | { readonly type: "error"; readonly error: unknown }

export interface IAgentModel {
  readonly stream: (
    request: IAgentModelRequest,
  ) => AsyncIterable<IAgentModelEvent>
}

export type { TAgentRunEndReason } from "@/domain"

export type TToolExecutionOutcome =
  | { readonly status: "completed"; readonly output: TJsonValue }
  | { readonly status: "error"; readonly error: string }
  | { readonly status: "cancelled"; readonly error: string }

export type IAgentEvent =
  | { readonly type: "agent_start" }
  | {
      readonly type: "agent_end"
      readonly reason: TAgentRunEndReason
      readonly messages: readonly IBuliMessageWithParts[]
    }
  | { readonly type: "turn_start"; readonly index: number }
  | {
      readonly type: "turn_end"
      readonly index: number
      readonly message: IBuliMessageWithParts
      readonly willContinue: boolean
    }
  | {
      readonly type: "message_start"
      readonly message: IBuliMessageWithParts
    }
  | {
      readonly type: "message_update"
      readonly message: IBuliMessageWithParts
    }
  | {
      readonly type: "message_end"
      readonly message: IBuliMessageWithParts
    }
  | {
      readonly type: "tool_execution_start"
      readonly toolCallID: string
      readonly toolName: string
      readonly input: TJsonObject
    }
  | {
      readonly type: "tool_execution_end"
      readonly toolCallID: string
      readonly toolName: string
      readonly input: TJsonObject
      readonly outcome: TToolExecutionOutcome
    }

export interface IAgentState {
  readonly sessionId: string
  readonly systemPrompt: string
  readonly tools: readonly IAgentTool[]
  readonly messages: readonly IBuliMessageWithParts[]
  readonly isRunning: boolean
  readonly streamingMessage: IBuliMessageWithParts | undefined
  readonly pendingToolCallIDs: ReadonlySet<string>
  readonly error: { readonly name: string; readonly message: string } | undefined
  readonly lastRunReason: TAgentRunEndReason | undefined
}

export type TAgentEventListener = (
  event: IAgentEvent,
  signal: AbortSignal,
) => void | Promise<void>

export interface IAgentLoopResult {
  readonly reason: TAgentRunEndReason
  readonly messages: readonly IBuliMessageWithParts[]
}
