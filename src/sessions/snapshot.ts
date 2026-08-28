import {
    isImmutableAssistantSnapshot,
    type TAgentMessage,
    type TAgentRunEndReason,
    type IAssistantMessage,
    type TToolApprovalRequest,
    type IUserMessage,
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

/** Per-session source identities paired with their last frozen publication. */
export interface ISessionSnapshotFreezeCache {
    source: ISessionSnapshot | undefined
    value: ISessionSnapshot | undefined
}

/** Clones and deeply freezes changed branches for safe publication. */
export function freezeSessionSnapshot(
    snapshot: ISessionSnapshot,
    cache?: ISessionSnapshotFreezeCache,
): ISessionSnapshot {
    const previousSource = cache?.source
    const previousValue = cache?.value
    // Branch source identity is the immutable-state boundary: unchanged values
    // reuse their frozen public copy while every publication gets a new shell.
    const frozen: ISessionSnapshot = Object.freeze({
        messages: freezeBranch(
            snapshot.messages,
            previousSource?.messages,
            previousValue?.messages,
        ),
        pendingSteeringMessages: freezeBranch(
            snapshot.pendingSteeringMessages,
            previousSource?.pendingSteeringMessages,
            previousValue?.pendingSteeringMessages,
        ),
        pendingFollowUpMessages: freezeBranch(
            snapshot.pendingFollowUpMessages,
            previousSource?.pendingFollowUpMessages,
            previousValue?.pendingFollowUpMessages,
        ),
        ...(snapshot.streamingMessage === undefined
            ? {}
            : {
                streamingMessage: freezeAssistantBranch(
                    snapshot.streamingMessage,
                    previousSource?.streamingMessage,
                    previousValue?.streamingMessage,
                ),
            }),
        ...(snapshot.pendingToolApproval === undefined
            ? {}
            : {
                pendingToolApproval: freezeBranch(
                    snapshot.pendingToolApproval,
                    previousSource?.pendingToolApproval,
                    previousValue?.pendingToolApproval,
                ),
            }),
        isRunning: snapshot.isRunning,
        isCompacting: snapshot.isCompacting,
        ...(snapshot.contextUsage === undefined
            ? {}
            : {
                contextUsage: freezeBranch(
                    snapshot.contextUsage,
                    previousSource?.contextUsage,
                    previousValue?.contextUsage,
                ),
            }),
        ...(snapshot.activeRunId === undefined
            ? {}
            : { activeRunId: snapshot.activeRunId }),
        pendingToolCallIds: freezeBranch(
            snapshot.pendingToolCallIds,
            previousSource?.pendingToolCallIds,
            previousValue?.pendingToolCallIds,
        ),
        ...(snapshot.lastRunReason === undefined
            ? {}
            : { lastRunReason: snapshot.lastRunReason }),
        ...(snapshot.errorMessage === undefined
            ? {}
            : { errorMessage: snapshot.errorMessage }),
    })
    if (cache) {
        cache.source = snapshot
        cache.value = frozen
    }
    return frozen
}

function freezeAssistantBranch(
    value: IAssistantMessage,
    previousSource: IAssistantMessage | undefined,
    previousValue: IAssistantMessage | undefined,
): IAssistantMessage {
    if (value === previousSource && previousValue !== undefined) {
        return previousValue
    }
    return isImmutableAssistantSnapshot(value)
        ? value
        : freezeBranch(value, previousSource, previousValue)
}

function freezeBranch<T extends object>(
    value: T,
    previousSource: T | undefined,
    previousValue: T | undefined,
): T {
    if (value === previousSource && previousValue !== undefined) {
        return previousValue
    }
    const clone = structuredClone(value)
    deepFreeze(clone)
    return clone
}

function deepFreeze(value: unknown): void {
    if (value === null || typeof value !== "object") return
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
}
