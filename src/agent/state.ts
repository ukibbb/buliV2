import type {
    AgentMessage,
    AssistantMessage,
} from "@/agent/messages"
import type { AgentTool } from "@/agent/tool"
import type { ToolApprovalRequest } from "@/agent/tool-approval"

/** Terminal reason published when an agent run settles. */
export type AgentRunEndReason =
    | "completed"
    | "aborted"
    | "error"
    | "internal-error"

export interface AgentContextProjection {
    readonly messages: readonly AgentMessage[]
    readonly contextSummary?: string
}

export type AgentContextProjector = (
    messages: readonly AgentMessage[],
) => AgentContextProjection

/** Immutable state published by one live Agent instance. */
export interface AgentState {
    readonly sessionId: string
    readonly systemPrompt: string
    readonly tools: readonly AgentTool[]
    readonly messages: readonly AgentMessage[]
    readonly isRunning: boolean
    readonly activeRunId: string | undefined
    readonly streamingMessage: AssistantMessage | undefined
    readonly pendingToolCallIds: ReadonlySet<string>
    readonly pendingToolApproval: ToolApprovalRequest | undefined
    readonly errorMessage: string | undefined
    readonly lastRunReason: AgentRunEndReason | undefined
}

export interface AgentRunHandle {
    readonly runId: string
    readonly accepted: Promise<void>
    readonly settled: Promise<void>
}

export interface AgentLoopResult {
    readonly reason: AgentRunEndReason
    readonly messages: readonly AgentMessage[]
}
