import type {
    IFileChangeProposalRecord,
    TAgentMessage,
} from "@/agent"
import type { ICompactionCheckpoint } from "@/sessions/compaction/checkpoint"

/** Lightweight session metadata used by navigation and persistence indexes. */
export interface ISessionInfo {
    readonly id: string
    readonly agentId: string
    readonly title: string
    readonly createdAt: number
    readonly updatedAt: number
}

/** Defines storage operations required by live and persisted sessions. */
export interface ISessionManager {
    readonly createSession: (info: ISessionInfo) => void
    /** Acquires session ownership and reloads history; failure retains other ownership. */
    readonly openSession?: (sessionId: string) => void
    /** Releases ownership after the caller has disposed the live session. */
    readonly releaseSession?: (sessionId: string) => void
    readonly getSessionInfo: (sessionId: string) => ISessionInfo | undefined
    readonly listSessions: () => readonly ISessionInfo[]
    readonly getMessages: (sessionId: string) => readonly TAgentMessage[]
    readonly appendMessage: (message: TAgentMessage) => void
    /**
     * Invalidates cached proposal/checkpoint presentation after successful saves
     * or session deletion/recreation, including same-ID replacements. Message
     * appends do not change this revision: live Agent state owns that branch.
     * Reading the revision must not clone the payload or perform storage I/O.
     */
    readonly getPresentationRevision: (sessionId: string) => number
    readonly getFileChangeProposals: (
        sessionId: string,
    ) => readonly IFileChangeProposalRecord[]
    readonly saveFileChangeProposal: (
        proposal: IFileChangeProposalRecord,
    ) => void
    readonly getCompactionCheckpoint: (
        sessionId: string,
    ) => ICompactionCheckpoint | undefined
    readonly saveCompactionCheckpoint: (
        checkpoint: ICompactionCheckpoint,
    ) => void
    readonly deleteSession: (sessionId: string) => void
    readonly dispose?: () => void | Promise<void>
}
