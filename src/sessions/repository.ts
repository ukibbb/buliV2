import type { AgentMessage } from "@/agent"
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
    readonly getSessionInfo: (sessionId: string) => ISessionInfo | undefined
    readonly listSessions: () => readonly ISessionInfo[]
    readonly getMessages: (sessionId: string) => readonly AgentMessage[]
    readonly appendMessage: (message: AgentMessage) => void
    readonly getCompactionCheckpoint: (
        sessionId: string,
    ) => ICompactionCheckpoint | undefined
    readonly saveCompactionCheckpoint: (
        checkpoint: ICompactionCheckpoint,
    ) => void
    readonly deleteSession: (sessionId: string) => void
    readonly dispose?: () => void | Promise<void>
}
