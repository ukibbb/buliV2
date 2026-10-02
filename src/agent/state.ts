import type {
    TAgentMessage,
    IAssistantMessage,
} from "@/agent/messages"
import type { IRuntimeAgentTool } from "@/agent/tool"

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

/** Error metadata, never a retained completed assistant payload. */
export interface IAssistantError {
    readonly id: string
    readonly runId: string
    readonly errorMessage: string
}

/** Immutable operational state published by one live Agent instance. */
export interface IAgentState {
    readonly sessionId: string
    readonly systemPrompt: string
    readonly tools: readonly IRuntimeAgentTool[]
    readonly assistantError: IAssistantError | undefined
    readonly isRunning: boolean
    readonly activeRunId: string | undefined
    readonly streamingMessage: IAssistantMessage | undefined
    readonly pendingToolCallIds: ReadonlySet<string>
    readonly errorMessage: string | undefined
    readonly lastRunReason: TAgentRunEndReason | undefined
}

export interface IAgentRunHandle {
    readonly runId: string
    readonly initialPromptProcessed: Promise<void>
    readonly runFinished: Promise<void>
}

export interface IAgentLoopResult {
    readonly reason: TAgentRunEndReason
}
