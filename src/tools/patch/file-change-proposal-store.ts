import type {
    IFileChangeProposal,
    IFileChangeProposalRecord,
    IFileChangeProposalSource,
    TFileChangeOperation,
    TFileChangeProposalStatus,
} from "@/agent"
import { generateRandomId } from "@/common/ids"

export interface IFileChangeProposalInput {
    readonly sessionId: string
    readonly runId: string
    readonly toolCallId: string
    readonly operation: TFileChangeOperation
    readonly path: string
    readonly baseContent: string | undefined
    readonly targetContent: string
    readonly diff: string
}

export interface IStoredFileChangeProposal extends IFileChangeProposal {
    readonly baseContent: string | undefined
    readonly targetContent: string
    readonly createdAt: number
}

type TFileChangeProposalListener = () => void

type TResolvedFileChangeProposalStatus = Exclude<
    TFileChangeProposalStatus,
    "pending"
>

export interface IFileChangeProposalStoreOptions {
    readonly generateId?: () => string
    readonly now?: () => number
    readonly saveProposal?: (proposal: IFileChangeProposalRecord) => void
}

/** Owns one pending, immutable file-change proposal per session. */
export class FileChangeProposalStore implements IFileChangeProposalSource {
    private readonly proposals = new Map<
        string,
        IStoredFileChangeProposal
    >()
    private readonly listeners = new Map<
        string,
        Set<TFileChangeProposalListener>
    >()
    private readonly generateId: () => string
    private readonly now: () => number
    private readonly saveProposal: (
        proposal: IFileChangeProposalRecord,
    ) => void

    constructor(
        options: IFileChangeProposalStoreOptions | (() => string) = {},
    ) {
        const resolvedOptions = typeof options === "function"
            ? { generateId: options }
            : options
        this.generateId = resolvedOptions.generateId ?? generateRandomId
        this.now = resolvedOptions.now ?? Date.now
        this.saveProposal = resolvedOptions.saveProposal ?? (() => undefined)
    }

    propose(input: IFileChangeProposalInput): IFileChangeProposal {
        const createdAt = this.now()
        const proposal = deepFreeze({
            id: this.generateId(),
            ...structuredClone(input),
            createdAt,
        })
        const previous = this.proposals.get(input.sessionId)
        if (previous) {
            this.saveResolvedProposal(previous, "expired", createdAt)
            this.proposals.delete(input.sessionId)
        }
        try {
            this.saveProposal(proposalRecord(proposal, "pending"))
        } catch (error) {
            if (previous) this.notify(input.sessionId)
            throw error
        }
        this.proposals.set(input.sessionId, proposal)
        this.notify(input.sessionId)
        return publicProposal(proposal)
    }

    getSnapshot(sessionId: string): IFileChangeProposal | undefined {
        const proposal = this.proposals.get(sessionId)
        return proposal === undefined
            ? undefined
            : publicProposal(proposal)
    }

    getForApply(
        sessionId: string,
        proposalId: string,
        currentRunId: string,
    ): IStoredFileChangeProposal {
        const proposal = this.requireProposal(sessionId, proposalId)
        if (proposal.runId === currentRunId) {
            throw new Error(
                "A file-change proposal cannot be applied in the run that created it.",
            )
        }
        return structuredClone(proposal)
    }

    resolve(
        sessionId: string,
        proposalId: string,
        status: TResolvedFileChangeProposalStatus = "expired",
    ): void {
        const proposal = this.requireProposal(sessionId, proposalId)
        this.saveResolvedProposal(proposal, status, this.now())
        this.proposals.delete(sessionId)
        this.notify(sessionId)
    }

    subscribe(
        sessionId: string,
        listener: TFileChangeProposalListener,
    ): () => void {
        const sessionListeners = this.listeners.get(sessionId) ?? new Set()
        sessionListeners.add(listener)
        this.listeners.set(sessionId, sessionListeners)

        return () => {
            sessionListeners.delete(listener)
            if (sessionListeners.size === 0) {
                this.listeners.delete(sessionId)
            }
        }
    }

    private requireProposal(
        sessionId: string,
        proposalId: string,
    ): IStoredFileChangeProposal {
        const proposal = this.proposals.get(sessionId)
        if (!proposal) {
            throw new Error(
                `No file-change proposal is pending for session "${sessionId}".`,
            )
        }
        if (proposal.id !== proposalId) {
            throw new Error(
                `File-change proposal ID mismatch: expected "${proposal.id}", received "${proposalId}".`,
            )
        }
        return proposal
    }

    private saveResolvedProposal(
        proposal: IStoredFileChangeProposal,
        status: TResolvedFileChangeProposalStatus,
        resolvedAt: number,
    ): void {
        this.saveProposal(proposalRecord(proposal, status, resolvedAt))
    }

    private notify(sessionId: string): void {
        const sessionListeners = this.listeners.get(sessionId)
        if (!sessionListeners) return
        for (const listener of [...sessionListeners]) listener()
    }
}

function proposalRecord(
    proposal: IStoredFileChangeProposal,
    status: TFileChangeProposalStatus,
    resolvedAt?: number,
): IFileChangeProposalRecord {
    return deepFreeze({
        ...publicProposal(proposal),
        status,
        createdAt: proposal.createdAt,
        ...(resolvedAt === undefined ? {} : { resolvedAt }),
    })
}

function publicProposal(
    proposal: IStoredFileChangeProposal,
): IFileChangeProposal {
    return deepFreeze({
        id: proposal.id,
        sessionId: proposal.sessionId,
        runId: proposal.runId,
        toolCallId: proposal.toolCallId,
        operation: proposal.operation,
        path: proposal.path,
        diff: proposal.diff,
    })
}

function deepFreeze<T>(value: T): T {
    if (value === null || typeof value !== "object") return value
    for (const child of Object.values(value)) deepFreeze(child)
    return Object.freeze(value)
}
