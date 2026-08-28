import type {
    TAgentMessage,
    IAssistantMessage,
} from "@/agent/messages"
import type { IAgentTool } from "@/agent/tool"
import type { TToolApprovalRequest } from "@/agent/tool-approval"

/** Terminal reason published when an agent run settles. */
export type TAgentRunEndReason =
    | "completed"
    | "aborted"
    | "error"
    | "internal-error"

export interface IAgentContextProjection {
    readonly messages: readonly TAgentMessage[]
    readonly contextSummary?: string
}

export type TAgentContextProjector = (
    messages: readonly TAgentMessage[],
) => IAgentContextProjection

/** Immutable state published by one live Agent instance. */
export interface IAgentState {
    readonly sessionId: string
    readonly systemPrompt: string
    readonly tools: readonly IAgentTool[]
    readonly messages: readonly TAgentMessage[]
    readonly isRunning: boolean
    readonly activeRunId: string | undefined
    readonly streamingMessage: IAssistantMessage | undefined
    readonly pendingToolCallIds: ReadonlySet<string>
    readonly pendingToolApproval: TToolApprovalRequest | undefined
    readonly errorMessage: string | undefined
    readonly lastRunReason: TAgentRunEndReason | undefined
}

export interface IAgentRunHandle {
    readonly runId: string
    readonly accepted: Promise<void>
    readonly settled: Promise<void>
}

export interface IAgentLoopResult {
    readonly reason: TAgentRunEndReason
    readonly messages: readonly TAgentMessage[]
}
