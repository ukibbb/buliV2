import { isDeepStrictEqual } from "node:util"
import {
    MAIN_BRANCH_ID,
    getParentBranchId,
    resolveBranchContext,
    validateSessionBranches,
    type ISessionBranchContext,
    type ISessionBranchData,
} from "@/sessions/branches"
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
    ISessionArchive,
} from "@/sessions/repository"
import {
    assertCompactionCheckpoint,
    assertDurableSessionMessage,
    assertFileChangeProposalRecord,
    assertSessionInfo,
} from "@/sessions/validation"

type TSessionId = string

interface ISessionConversationState {
    readonly activeBranchId: string
    readonly branches: ReadonlyMap<string, ISessionBranchData>
}

/** Stores defensive session copies separately from live Agent state. */
export class InMemorySessionManager implements ISessionManager {
    private readonly sessionsById = new Map<TSessionId, ISessionInfo>()
    private readonly conversationsBySession = new Map<TSessionId, ISessionConversationState>()
    private readonly proposalsBySession = new Map<
        TSessionId,
        readonly IFileChangeProposalRecord[]
    >()
    // Presentation getters remain defensive. A separate revision lets live
    // sessions skip those clones during text streaming. Tokens are allocated
    // across this manager, not reset per ID, so delete/recreate cannot reuse a
    // cached session's old token. Only successful authoritative writes advance it.
    private readonly presentationRevisions = new Map<TSessionId, number>()
    private nextPresentationRevision = 0

    readonly createSession = (info: ISessionInfo): void => {
        assertSessionInfo(info)
        if (this.sessionsById.has(info.id)) {
            throw new Error(`Session already exists: ${info.id}`)
        }

        this.sessionsById.set(info.id, structuredClone(info))
        this.conversationsBySession.set(info.id, {
            activeBranchId: MAIN_BRANCH_ID,
            branches: new Map([[MAIN_BRANCH_ID, {
                branch: { id: MAIN_BRANCH_ID, origin: null, inheritedCheckpointId: null },
                messages: [],
                checkpoints: [],
            }]]),
        })
        this.presentationRevisions.set(info.id, ++this.nextPresentationRevision)
    }

    readonly restoreSessionArchive = (archive: ISessionArchive): void => {
        const copy = structuredClone(archive)
        assertSessionInfo(copy.info)
        const sessionId = copy.info.id
        if (this.sessionsById.has(sessionId)) {
            throw new Error(`Session already exists: ${sessionId}`)
        }

        const branches = new Map<string, ISessionBranchData>()
        for (const data of copy.branches) {
            if (branches.has(data.branch.id)) {
                throw new Error(`Duplicate branch ID: ${data.branch.id}`)
            }
            branches.set(data.branch.id, data)
        }
        validateSessionBranches(sessionId, branches)
        if (!branches.has(copy.activeBranchId)) {
            throw new Error(`Branch does not exist: ${copy.activeBranchId}`)
        }

        const proposalIds = new Set<string>()
        for (const proposal of copy.fileChangeProposals) {
            assertFileChangeProposalRecord(proposal)
            if (proposal.sessionId !== sessionId) {
                throw new Error(`Proposal ${proposal.id} belongs to another session`)
            }
            if (proposalIds.has(proposal.id)) {
                throw new Error(`Duplicate proposal ID: ${proposal.id}`)
            }
            proposalIds.add(proposal.id)
        }

        this.sessionsById.set(sessionId, copy.info)
        this.conversationsBySession.set(sessionId, {
            activeBranchId: copy.activeBranchId,
            branches,
        })
        this.proposalsBySession.set(sessionId, copy.fileChangeProposals)
        this.presentationRevisions.set(sessionId, ++this.nextPresentationRevision)
    }

    readonly getSessionInfo = (sessionId: string): ISessionInfo | undefined => {
        const info = this.sessionsById.get(sessionId)
        return info === undefined ? undefined : structuredClone(info)
    }

    readonly listSessions = (): readonly ISessionInfo[] => {
        return structuredClone([...this.sessionsById.values()])
    }

    readonly getMessages = (sessionId: string): readonly TAgentMessage[] => {
        return this.conversationsBySession.has(sessionId)
            ? this.getActiveContext(sessionId).messages
            : []
    }

    readonly validateMessageAppend = (message: TAgentMessage): void => {
        assertDurableSessionMessage(message)

        const info = this.sessionsById.get(message.sessionId)
        if (!info) {
            throw new Error(`Session does not exist: ${message.sessionId}`)
        }

        const state = this.requireConversation(message.sessionId)
        const active = state.branches.get(state.activeBranchId)!
        for (const [id, data] of state.branches) {
            if (id !== state.activeBranchId && data.messages.some((item) => item.id === message.id)) {
                throw new Error(`Message ${message.id} belongs to another branch`)
            }
        }
        const existingIndex = active.messages.findIndex((item) => item.id === message.id)
        if (existingIndex !== -1) {
            if (isDeepStrictEqual(active.messages[existingIndex], message)) return
            for (const data of state.branches.values()) {
                if (data.branch.origin?.branchId !== state.activeBranchId) continue
                const anchorId = data.branch.origin.throughMessageId
                const anchorIndex = active.messages.findIndex((item) => item.id === anchorId)
                if (existingIndex <= anchorIndex) {
                    throw new Error(`Message ${message.id} is inherited by a child branch`)
                }
            }
        }
    }

    readonly appendMessage = (message: TAgentMessage): void => {
        this.validateMessageAppend(message)
        const info = this.sessionsById.get(message.sessionId)!
        const state = this.requireConversation(message.sessionId)
        const active = state.branches.get(state.activeBranchId)!
        const existingIndex = active.messages.findIndex((item) => item.id === message.id)
        if (existingIndex !== -1 && isDeepStrictEqual(active.messages[existingIndex], message)) return
        const updated = [...active.messages]
        if (existingIndex === -1) updated.push(structuredClone(message))
        else updated[existingIndex] = structuredClone(message)
        this.replaceActiveData(message.sessionId, state, { ...active, messages: updated })
        this.sessionsById.set(message.sessionId, {
            ...info,
            updatedAt: Math.max(info.updatedAt, message.createdAt),
        })
    }

    readonly getPresentationRevision = (sessionId: string): number => {
        return this.presentationRevisions.get(sessionId) ?? -1
    }

    readonly getFileChangeProposals = (
        sessionId: string,
    ): readonly IFileChangeProposalRecord[] => {
        return structuredClone(this.proposalsBySession.get(sessionId) ?? [])
    }

    /** Restores a legacy record during history replay; does not write to disk. */
    readonly restoreFileChangeProposal = (
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
        this.presentationRevisions.set(proposal.sessionId, ++this.nextPresentationRevision)
    }

    readonly getCompactionCheckpoint = (
        sessionId: string,
    ): ICompactionCheckpoint | undefined => {
        return this.conversationsBySession.has(sessionId)
            ? this.getActiveContext(sessionId).checkpoint
            : undefined
    }

    readonly validateCheckpointSave = (
        checkpoint: ICompactionCheckpoint,
    ): void => {
        assertCompactionCheckpoint(checkpoint)
        if (!this.sessionsById.has(checkpoint.sessionId)) {
            throw new Error(`Session does not exist: ${checkpoint.sessionId}`)
        }
        const state = this.requireConversation(checkpoint.sessionId)
        const active = state.branches.get(state.activeBranchId)!
        assertCheckpointAnchor(checkpoint, this.getActiveContext(checkpoint.sessionId).messages)
        for (const [id, data] of state.branches) {
            if (id !== state.activeBranchId && data.checkpoints.some((item) => item.id === checkpoint.id)) {
                throw new Error(`Checkpoint ${checkpoint.id} belongs to another branch`)
            }
        }
        const existing = active.checkpoints.find((item) => item.id === checkpoint.id)
        if (existing && !isDeepStrictEqual(existing, checkpoint)) {
            for (const data of state.branches.values()) {
                if (data.branch.inheritedCheckpointId === checkpoint.id) {
                    throw new Error(`Checkpoint ${checkpoint.id} is inherited by a child branch`)
                }
            }
        }
    }

    readonly saveCompactionCheckpoint = (checkpoint: ICompactionCheckpoint): void => {
        this.validateCheckpointSave(checkpoint)
        const state = this.requireConversation(checkpoint.sessionId)
        const active = state.branches.get(state.activeBranchId)!
        const checkpoints = active.checkpoints.filter((item) => item.id !== checkpoint.id)
        this.replaceActiveData(checkpoint.sessionId, state, {
            ...active,
            checkpoints: [...checkpoints, structuredClone(checkpoint)],
        })
        this.presentationRevisions.set(checkpoint.sessionId, ++this.nextPresentationRevision)
    }

    readonly deleteSession = (sessionId: string): void => {
        this.sessionsById.delete(sessionId)
        this.conversationsBySession.delete(sessionId)
        this.proposalsBySession.delete(sessionId)
        this.presentationRevisions.delete(sessionId)
    }

    getAllMessages(): readonly TAgentMessage[] {
        return structuredClone([...this.conversationsBySession.values()].flatMap(
            (state) => [...state.branches.values()].flatMap((data) => data.messages),
        ))
    }

    readonly getActiveBranchId = (sessionId: string): string => {
        return this.requireConversation(sessionId).activeBranchId
    }

    readonly getActiveContext = (sessionId: string): ISessionBranchContext => {
        const state = this.requireConversation(sessionId)
        return resolveBranchContext(state.branches, state.activeBranchId)
    }

    readonly prepareBranch = (sessionId: string, branchId: string): ISessionBranchData["branch"] => {
        const state = this.requireConversation(sessionId)
        if (!branchId.trim()) throw new Error("Branch ID must not be empty")
        if (state.branches.has(branchId)) throw new Error(`Branch already exists: ${branchId}`)
        const context = this.getActiveContext(sessionId)
        return {
            id: branchId,
            origin: {
                branchId: state.activeBranchId,
                throughMessageId: context.messages.at(-1)?.id ?? null,
            },
            inheritedCheckpointId: context.checkpoint?.id ?? null,
        }
    }

    readonly createBranch = (sessionId: string, branchId: string): void => {
        const branch = this.prepareBranch(sessionId, branchId)
        const state = this.requireConversation(sessionId)
        const branches = new Map(state.branches)
        branches.set(branchId, {
            branch,
            messages: [],
            checkpoints: [],
        })
        this.conversationsBySession.set(sessionId, { activeBranchId: branchId, branches })
        this.presentationRevisions.set(sessionId, ++this.nextPresentationRevision)
    }

    readonly getParentBranchId = (sessionId: string): string => {
        const state = this.requireConversation(sessionId)
        return getParentBranchId(state.branches, state.activeBranchId)
    }

    readonly returnToParentBranch = (sessionId: string): void => {
        const state = this.requireConversation(sessionId)
        const activeBranchId = this.getParentBranchId(sessionId)
        this.conversationsBySession.set(sessionId, { ...state, activeBranchId })
        this.presentationRevisions.set(sessionId, ++this.nextPresentationRevision)
    }

    readonly getSessionArchive = (sessionId: string): ISessionArchive => {
        const state = this.requireConversation(sessionId)
        return structuredClone({
            info: this.sessionsById.get(sessionId)!,
            activeBranchId: state.activeBranchId,
            branches: [...state.branches.values()],
            fileChangeProposals: this.proposalsBySession.get(sessionId) ?? [],
        })
    }

    private requireConversation(sessionId: string): ISessionConversationState {
        const state = this.conversationsBySession.get(sessionId)
        if (!state) throw new Error(`Session does not exist: ${sessionId}`)
        return state
    }

    private replaceActiveData(
        sessionId: string,
        state: ISessionConversationState,
        data: ISessionBranchData,
    ): void {
        const branches = new Map(state.branches)
        branches.set(state.activeBranchId, data)
        this.conversationsBySession.set(sessionId, { ...state, branches })
    }
}
