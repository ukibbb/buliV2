/** User decision that resolves one pending local tool action. */
export type TToolApprovalDecision = "approve" | "reject" | "copy"

/** Approval payload shown before executing an arbitrary command. */
export interface ICommandToolApprovalDraft {
    readonly kind: "command"
    readonly title: string
    readonly explanation: string
    readonly command: string
    readonly cwd: string
    readonly purpose: string
    readonly expectedOutcome: string
    readonly sideEffects: string
    readonly timeoutSeconds: number
}

export type TToolApprovalDraft = ICommandToolApprovalDraft

interface IToolApprovalRequestBase {
    readonly id: string
    readonly sessionId: string
    readonly runId: string
    readonly toolCallId: string
}

export interface ICommandToolApprovalRequest
    extends IToolApprovalRequestBase, ICommandToolApprovalDraft {}

/** Ephemeral request currently awaiting a user decision. */
export type TToolApprovalRequest = ICommandToolApprovalRequest

/** Creates the immutable approval request published to agent observers. */
export function createToolApprovalRequest(
    draft: TToolApprovalDraft,
    id: string,
    sessionId: string,
    runId: string,
    toolCallId: string,
): TToolApprovalRequest {
    const identity = { id, sessionId, runId, toolCallId }
    const request: TToolApprovalRequest = {
        ...identity,
        kind: "command",
        title: draft.title,
        explanation: draft.explanation,
        command: draft.command,
        cwd: draft.cwd,
        purpose: draft.purpose,
        expectedOutcome: draft.expectedOutcome,
        sideEffects: draft.sideEffects,
        timeoutSeconds: draft.timeoutSeconds,
    }
    deepFreeze(request)
    return request
}

/** Rejects decisions that are unknown or invalid for the requested tool action. */
export function assertToolApprovalDecision(
    _request: TToolApprovalRequest,
    decision: TToolApprovalDecision,
): void {
    if (
        decision !== "approve"
        && decision !== "reject"
        && decision !== "copy"
    ) {
        throw new Error(`Invalid tool approval decision: ${String(decision)}`)
    }
}

/** Resolves the error text used when a pending approval is cancelled. */
export function toolApprovalAbortMessage(signal: AbortSignal): string {
    if (signal.reason instanceof Error) return signal.reason.message
    if (typeof signal.reason === "string") return signal.reason
    return signal.aborted
        ? "Buli interaction was aborted"
        : "Tool approval was cancelled before receiving a decision"
}

function deepFreeze(value: unknown): void {
    if (value === null || typeof value !== "object") return
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
}
