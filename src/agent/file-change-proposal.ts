export type TFileChangeOperation = "edit" | "write"

export type TFileChangeProposalStatus =
    | "pending"
    | "applied"
    | "rejected"
    | "expired"

export interface IFileChangeProposal {
    readonly id: string
    readonly sessionId: string
    readonly runId: string
    readonly toolCallId: string
    readonly operation: TFileChangeOperation
    readonly path: string
    readonly diff: string
}

/** Durable public proposal state rendered in the session transcript. */
export interface IFileChangeProposalRecord extends IFileChangeProposal {
    readonly status: TFileChangeProposalStatus
    readonly createdAt: number
    readonly resolvedAt?: number
}

/** Read-only proposal state consumed by a live session. */
export interface IFileChangeProposalSource {
    readonly getSnapshot: (
        sessionId: string,
    ) => IFileChangeProposal | undefined
    readonly subscribe: (
        sessionId: string,
        listener: () => void,
    ) => () => void
}
