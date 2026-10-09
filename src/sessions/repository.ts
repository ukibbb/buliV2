import type { IUserPathReference } from "@/agent"
import type { ICompactionCheckpoint } from "@/sessions/compaction/checkpoint"
import type { IHistoryCursor, IHistoryPage, IRequiredContext, TAppendMessageResult, TStoredMessage } from "@/sessions/history-contracts"

/** Lightweight session metadata used by navigation and persistence indexes. */
export interface ISessionInfo {
    readonly id: string
    readonly agentId: string
    readonly title: string
    readonly createdAt: number
    readonly updatedAt: number
}

/** Selective durable reads; callers never own a second archive. */
export interface ISessionManager {
    readonly getActiveBranchId: (sessionId: string) => string
    readonly createBranch: (sessionId: string, branchId: string) => void
    readonly returnToParentBranch: (sessionId: string) => void
    readonly createSession: (info: ISessionInfo) => void
    readonly updateSessionAgent: (sessionId: string, agentId: string) => void
    readonly openSession: (sessionId: string) => void
    readonly releaseSession: (sessionId: string) => void
    readonly getSessionInfo: (sessionId: string) => ISessionInfo | undefined
    readonly listSessions: () => readonly ISessionInfo[]
    readonly appendMessage: (message: TStoredMessage) => TAppendMessageResult
    readonly recoverInterruptedTools: (sessionId: string) => void
    readonly loadRequiredContext: (sessionId: string) => IRequiredContext
    readonly loadRecentConversation: (sessionId: string) => readonly TStoredMessage[]
    readonly loadSelectedPaths: (sessionId: string) => readonly IUserPathReference[]
    readonly loadHistoryPage: (sessionId: string, branchId: string, cursor?: IHistoryCursor) => IHistoryPage
    readonly getCompactionCheckpoint: (sessionId: string) => ICompactionCheckpoint | undefined
    readonly saveCompactionCheckpoint: (checkpoint: ICompactionCheckpoint) => void
    /** Atomically deletes only a creation with no committed messages/checkpoints in any branch. */
    readonly deleteEmptySession: (sessionId: string) => boolean
    readonly deleteSession: (sessionId: string) => void
    readonly dispose: () => void | Promise<void>
}
