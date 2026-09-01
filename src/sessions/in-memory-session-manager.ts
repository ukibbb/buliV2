import type {
    IFileChangeProposalRecord,
    TAgentMessage,
} from "@/agent"
import {
    assertCheckpointAnchor,
    type ICompactionCheckpoint,
} from "@/sessions/compaction/checkpoint"
import type {
    ISessionInfo,
    ISessionManager,
} from "@/sessions/repository"
import {
    assertCompactionCheckpoint,
    assertDurableSessionMessage,
    assertFileChangeProposalRecord,
    assertSessionInfo,
} from "@/sessions/validation"

type TSessionId = string

/** Stores defensive session copies separately from live Agent state. */
export class InMemorySessionManager implements ISessionManager {
    private readonly sessionsById = new Map<TSessionId, ISessionInfo>()
    private readonly messagesBySession = new Map<
        TSessionId,
        readonly TAgentMessage[]
    >()
    private readonly checkpointsBySession = new Map<
        TSessionId,
        ICompactionCheckpoint
    >()
    private readonly proposalsBySession = new Map<
        TSessionId,
        readonly IFileChangeProposalRecord[]
    >()

    readonly createSession = (info: ISessionInfo): void => {
        assertSessionInfo(info)
        if (this.sessionsById.has(info.id)) {
            throw new Error(`Session already exists: ${info.id}`)
        }

        this.sessionsById.set(info.id, structuredClone(info))
    }

    readonly getSessionInfo = (sessionId: string): ISessionInfo | undefined => {
        const info = this.sessionsById.get(sessionId)
        return info === undefined ? undefined : structuredClone(info)
    }

    readonly listSessions = (): readonly ISessionInfo[] => {
        return structuredClone([...this.sessionsById.values()])
    }

    readonly getMessages = (sessionId: string): readonly TAgentMessage[] => {
        return structuredClone(this.messagesBySession.get(sessionId) ?? [])
    }

    readonly appendMessage = (message: TAgentMessage): void => {
        assertDurableSessionMessage(message)

        const info = this.sessionsById.get(message.sessionId)
        if (!info) {
            throw new Error(`Session does not exist: ${message.sessionId}`)
        }

        const current = this.messagesBySession.get(message.sessionId) ?? []
        const existingIndex = current.findIndex(
            (candidate) => candidate.id === message.id,
        )
        const updated = [...current]

        if (existingIndex === -1) updated.push(structuredClone(message))
        else updated[existingIndex] = structuredClone(message)

        this.messagesBySession.set(message.sessionId, updated)
        this.sessionsById.set(message.sessionId, {
            ...info,
            updatedAt: Math.max(info.updatedAt, message.createdAt),
        })
    }

    readonly getFileChangeProposals = (
        sessionId: string,
    ): readonly IFileChangeProposalRecord[] => {
        return structuredClone(this.proposalsBySession.get(sessionId) ?? [])
    }

    readonly saveFileChangeProposal = (
        proposal: IFileChangeProposalRecord,
    ): void => {
        assertFileChangeProposalRecord(proposal)
        if (!this.sessionsById.has(proposal.sessionId)) {
            throw new Error(`Session does not exist: ${proposal.sessionId}`)
        }

        const current = this.proposalsBySession.get(proposal.sessionId) ?? []
        const existingIndex = current.findIndex(
            (candidate) => candidate.id === proposal.id,
        )
        const updated = [...current]

        if (existingIndex === -1) updated.push(structuredClone(proposal))
        else updated[existingIndex] = structuredClone(proposal)

        this.proposalsBySession.set(proposal.sessionId, updated)
    }

    readonly getCompactionCheckpoint = (
        sessionId: string,
    ): ICompactionCheckpoint | undefined => {
        const checkpoint = this.checkpointsBySession.get(sessionId)
        return checkpoint === undefined
            ? undefined
            : structuredClone(checkpoint)
    }

    readonly saveCompactionCheckpoint = (
        checkpoint: ICompactionCheckpoint,
    ): void => {
        assertCompactionCheckpoint(checkpoint)
        if (!this.sessionsById.has(checkpoint.sessionId)) {
            throw new Error(`Session does not exist: ${checkpoint.sessionId}`)
        }
        assertCheckpointAnchor(
            checkpoint,
            this.messagesBySession.get(checkpoint.sessionId) ?? [],
        )
        this.checkpointsBySession.set(
            checkpoint.sessionId,
            structuredClone(checkpoint),
        )
    }

    readonly deleteSession = (sessionId: string): void => {
        this.sessionsById.delete(sessionId)
        this.messagesBySession.delete(sessionId)
        this.checkpointsBySession.delete(sessionId)
        this.proposalsBySession.delete(sessionId)
    }

    getAllMessages(): readonly TAgentMessage[] {
        return structuredClone([...this.messagesBySession.values()].flat())
    }
}
