import type {
    IAssistantMessage,
    IUserMessage,
    TAgentMessage,
    TAgentRunEndReason,
    TToolApprovalRequest,
} from "@/agent"
import type { IContextUsage } from "@/sessions/compaction/context-budget"

/** Immutable read model published by one live agent session. */
export interface ISessionSnapshot {
    readonly messages: readonly TAgentMessage[]
    readonly pendingSteeringMessages: readonly IUserMessage[]
    readonly pendingFollowUpMessages: readonly IUserMessage[]
    readonly streamingMessage?: IAssistantMessage
    readonly pendingToolApproval?: TToolApprovalRequest
    readonly isRunning: boolean
    readonly isCompacting: boolean
    readonly contextUsage?: IContextUsage
    readonly activeRunId?: string
    readonly pendingToolCallIds: readonly string[]
    readonly lastRunReason?: TAgentRunEndReason
    readonly errorMessage?: string
}

/** Clones and deeply freezes a session snapshot for safe publication. */
export function freezeSessionSnapshot(
    snapshot: ISessionSnapshot,
): ISessionSnapshot {
    const clone = structuredClone(snapshot)
    deepFreeze(clone)
    return clone
}

function deepFreeze(value: unknown): void {
    if (value === null || typeof value !== "object") return
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
}
