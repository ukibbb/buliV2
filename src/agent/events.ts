import type { AgentModelEvent } from "@/agent/model"
import type {
    AgentMessage,
    AssistantMessage,
    ToolResultMessage,
} from "@/agent/messages"
import type { AgentRunEndReason } from "@/agent/state"
import type {
    ToolApprovalDecision,
    ToolApprovalRequest,
} from "@/agent/tool-approval"

interface AgentEventBase {
    readonly runId: string
}

type AgentEventPayload =
    | { readonly type: "agent_start" }
    | {
        readonly type: "agent_end"
        readonly reason: AgentRunEndReason
        readonly messages: readonly AgentMessage[]
    }
    | { readonly type: "turn_start"; readonly index: number }
    | {
        readonly type: "turn_end"
        readonly index: number
        readonly message: AssistantMessage
        readonly toolResults: readonly ToolResultMessage[]
        readonly willContinue: boolean
    }
    | { readonly type: "message_start"; readonly message: AgentMessage }
    | {
        readonly type: "message_update"
        readonly message: AssistantMessage
        readonly modelEvent: AgentModelEvent
    }
    | { readonly type: "message_end"; readonly message: AgentMessage }
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
        readonly result: ToolResultMessage
    }
    | {
        readonly type: "tool_approval_requested"
        readonly request: ToolApprovalRequest
    }
    | {
        readonly type: "tool_approval_resolved"
        readonly approvalId: string
        readonly decision: ToolApprovalDecision | undefined
    }
    | {
        readonly type: "agent_settled"
        readonly reason: AgentRunEndReason
        readonly errorMessage?: string
    }

/** Event protocol connecting live agent execution with persistence and UI. */
export type AgentEvent = AgentEventBase & AgentEventPayload

export type AgentEventListener = (
    event: AgentEvent,
    signal: AbortSignal,
) => void | Promise<void>

/** Critical sink that must finish before an event is considered accepted. */
export type AgentCriticalEventSink = (
    event: AgentEvent,
    signal: AbortSignal,
) => void | Promise<void>
