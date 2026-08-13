import type {
  IAssistantMessage,
  IToolResultMessage,
  TAgentMessage,
  TAgentRunEndReason,
} from "@/domain"

export interface IAgentToolDescriptor {
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
}

export interface IAgentToolExecutionContext {
  readonly toolCallId: string
  readonly signal: AbortSignal
}

export interface IAgentTool extends IAgentToolDescriptor {
  readonly execute: (
    input: Record<string, unknown>,
    context: IAgentToolExecutionContext,
  ) => Promise<string>
}

export interface IAgentModelRequest {
  readonly sessionId: string
  readonly systemPrompt: string
  readonly messages: readonly TAgentMessage[]
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
      readonly toolCallId: string
      readonly toolName: string
      readonly input: Record<string, unknown>
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

export type IAgentEvent =
  | { readonly type: "agent_start" }
  | {
      readonly type: "agent_end"
      readonly reason: TAgentRunEndReason
      readonly messages: readonly TAgentMessage[]
    }
  | { readonly type: "turn_start"; readonly index: number }
  | {
      readonly type: "turn_end"
      readonly index: number
      readonly message: IAssistantMessage
      readonly toolResults: readonly IToolResultMessage[]
      readonly willContinue: boolean
    }
  | { readonly type: "message_start"; readonly message: TAgentMessage }
  | {
      readonly type: "message_update"
      readonly message: IAssistantMessage
      readonly modelEvent: IAgentModelEvent
    }
  | { readonly type: "message_end"; readonly message: TAgentMessage }
  | {
      readonly type: "tool_execution_start"
      readonly toolCallId: string
      readonly toolName: string
      readonly input: Record<string, unknown>
    }
  | {
      readonly type: "tool_execution_end"
      readonly toolCallId: string
      readonly toolName: string
      readonly result: IToolResultMessage
    }

export interface IAgentState {
  readonly sessionId: string
  readonly systemPrompt: string
  readonly tools: readonly IAgentTool[]
  readonly messages: readonly TAgentMessage[]
  readonly isRunning: boolean
  readonly streamingMessage: IAssistantMessage | undefined
  readonly pendingToolCallIds: ReadonlySet<string>
  readonly errorMessage: string | undefined
  readonly lastRunReason: TAgentRunEndReason | undefined
}

export type TAgentEventListener = (
  event: IAgentEvent,
  signal: AbortSignal,
) => void | Promise<void>

export interface IAgentLoopResult {
  readonly reason: TAgentRunEndReason
  readonly messages: readonly TAgentMessage[]
}
