import type { TAgentModelEvent } from "@/agent/model"
import type {
    TAgentMessage,
    IAssistantMessage,
    IToolResultMessage,
} from "@/agent/messages"
import type { TAgentRunEndReason } from "@/agent/state"

interface IAgentEventBase {
    readonly runId: string
}

type TAgentEventPayload =
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
        readonly modelEvent: TAgentModelEvent
    }
    | { readonly type: "message_end"; readonly message: TAgentMessage }
    | {
        readonly type: "tool_execution_start"
        readonly toolCallId: string
        readonly toolName: string
        readonly input: Record<string, unknown>
    }
    | {
        readonly type: "tool_execution_update"
        readonly toolCallId: string
        readonly toolName: string
        readonly progress: string
    }
    | {
        readonly type: "tool_execution_end"
        readonly toolCallId: string
        readonly toolName: string
        readonly result: IToolResultMessage
    }
    | {
        readonly type: "agent_settled"
        readonly reason: TAgentRunEndReason
        readonly errorMessage?: string
    }

/** Event protocol connecting live agent execution with persistence and UI. */
export type TAgentEvent = IAgentEventBase & TAgentEventPayload

export type TAgentEventListener = (
    event: TAgentEvent,
    signal: AbortSignal,
) => void | Promise<void>

/** Critical sink that must finish before an event is considered accepted. */
export type TAgentCriticalEventSink = (
    event: TAgentEvent,
    signal: AbortSignal,
) => void | Promise<void>
