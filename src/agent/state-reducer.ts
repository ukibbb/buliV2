import type { IAgentEvent } from "@/agent/events"
import type { IAgentState } from "@/agent/state"

/** Applies one agent event to immutable live state without performing side effects. */
export function reduceAgentState(
    state: IAgentState,
    event: IAgentEvent,
): IAgentState {
    switch (event.type) {
        case "agent_start":
            return { ...state, isRunning: true }
        case "message_start":
            if (event.message.role !== "assistant") return state
            return {
                ...state,
                streamingMessage: structuredClone(event.message),
            }
        case "message_update":
            return {
                ...state,
                streamingMessage: structuredClone(event.message),
            }
        case "message_end":
            return {
                ...state,
                messages: [...state.messages, structuredClone(event.message)],
                streamingMessage: event.message.role === "assistant"
                    ? undefined
                    : state.streamingMessage,
            }
        case "tool_execution_start": {
            const pendingToolCallIds = new Set(state.pendingToolCallIds)
            pendingToolCallIds.add(event.toolCallId)
            return { ...state, pendingToolCallIds }
        }
        case "tool_execution_end": {
            const pendingToolCallIds = new Set(state.pendingToolCallIds)
            pendingToolCallIds.delete(event.toolCallId)
            return { ...state, pendingToolCallIds }
        }
        case "tool_approval_requested":
            return Object.freeze({
                ...state,
                pendingToolApproval: event.request,
            })
        case "tool_approval_resolved":
            if (state.pendingToolApproval?.id !== event.approvalId) return state
            return {
                ...state,
                pendingToolApproval: undefined,
            }
        case "turn_end":
            return {
                ...state,
                errorMessage: event.message.errorMessage,
            }
        case "agent_end":
            return {
                ...state,
                lastRunReason: event.reason,
            }
        case "agent_settled":
        case "tool_execution_update":
        case "turn_start":
            return state
    }
}
