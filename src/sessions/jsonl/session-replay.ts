import { isDeepStrictEqual } from "node:util"
import type { IFileChangeProposalRecord, TAgentMessage } from "@/agent"
import {
    MAIN_BRANCH_ID,
    resolveBranchContext,
    type ISessionBranch,
    type ISessionBranchData,
} from "@/sessions/branches"
import { assertCheckpointAnchor, type ICompactionCheckpoint } from "@/sessions/compaction/checkpoint"
import { assertSessionRecord, SessionRecordType, type TSessionRecord } from "@/sessions/jsonl/session-records"
import type { ISessionArchive, ISessionInfo } from "@/sessions/repository"

export interface ICheckpointReplayWarning {
    readonly recordIndex: number
    readonly checkpointId: string
    readonly reason: string
}

export interface ISessionReplayResult {
    readonly archives: readonly ISessionArchive[]
    readonly warnings: readonly ICheckpointReplayWarning[]
}

export class SessionReplayError extends Error {
    constructor(readonly recordIndex: number, cause: unknown) {
        super(`Invalid session record at index ${recordIndex}: ${errorText(cause)}`, { cause })
        this.name = "SessionReplayError"
    }
}

interface IReplayBranch {
    readonly branch: ISessionBranch
    readonly messages: TAgentMessage[]
    checkpoints: ICompactionCheckpoint[]
}

interface IReplaySession {
    info: ISessionInfo
    activeBranchId: string
    readonly branches: Map<string, IReplayBranch>
    readonly proposals: Map<string, IFileChangeProposalRecord>
    readonly messageOwners: Map<string, string>
    readonly checkpointOwners: Map<string, string>
    readonly checkpointRecords: Map<string, number>
}

export function replaySessionRecords(records: readonly TSessionRecord[]): ISessionReplayResult {
    const sessions = new Map<string, IReplaySession>()
    const warnings = new Map<number, ICheckpointReplayWarning>()

    const warnCheckpoint = (recordIndex: number, checkpoint: ICompactionCheckpoint, messages: readonly TAgentMessage[]) => {
        try {
            assertCheckpointAnchor(checkpoint, messages)
        } catch (error) {
            warnings.set(recordIndex, { recordIndex, checkpointId: checkpoint.id, reason: errorText(error) })
        }
    }

    for (const [recordIndex, input] of records.entries()) {
        try {
            assertSessionRecord(input)
            const record = structuredClone(input)
            if (record.recordType === SessionRecordType.Session) {
                const previous = sessions.get(record.session.id)
                if (previous) {
                    if (previous.info.agentId !== record.session.agentId
                        || previous.info.createdAt !== record.session.createdAt) {
                        throw new Error("Session identity cannot change")
                    }
                    previous.info = { ...record.session, updatedAt: Math.max(previous.info.updatedAt, record.session.updatedAt) }
                } else {
                    sessions.set(record.session.id, {
                        info: record.session,
                        activeBranchId: MAIN_BRANCH_ID,
                        branches: new Map([[MAIN_BRANCH_ID, {
                            branch: { id: MAIN_BRANCH_ID, origin: null, inheritedCheckpointId: null },
                            messages: [], checkpoints: [],
                        }]]),
                        proposals: new Map(), messageOwners: new Map(),
                        checkpointOwners: new Map(), checkpointRecords: new Map(),
                    })
                }
                continue
            }
            const sessionId = record.recordType === SessionRecordType.Message ? record.message.sessionId
                : record.recordType === SessionRecordType.Compaction ? record.checkpoint.sessionId
                : record.recordType === SessionRecordType.FileChangeProposal ? record.proposal.sessionId
                : record.sessionId
            const session = sessions.get(sessionId)
            if (!session) throw new Error(`Missing session metadata: ${sessionId}`)

            switch (record.recordType) {
                case SessionRecordType.Branch: {
                    if (session.branches.has(record.branch.id)) throw new Error(`Duplicate branch: ${record.branch.id}`)
                    if (record.branch.origin === null) throw new Error("Only main may have no parent")
                    requireBranch(session, record.branch.origin.branchId)
                    session.branches.set(record.branch.id, { branch: record.branch, messages: [], checkpoints: [] })
                    resolveBranchContext(session.branches, record.branch.id)
                    session.activeBranchId = record.branch.id
                    break
                }
                case SessionRecordType.BranchSelection:
                    requireBranch(session, record.branchId)
                    session.activeBranchId = record.branchId
                    break
                case SessionRecordType.Message: {
                    const data = requireBranch(session, record.branchId)
                    assertOwner(session.messageOwners, record.message.id, record.branchId)
                    const index = data.messages.findIndex((item) => item.id === record.message.id)
                    if (index !== -1 && !isDeepStrictEqual(data.messages[index], record.message)) {
                        assertMessageUnshared(session, record.branchId, index)
                    }
                    if (index === -1) data.messages.push(record.message)
                    else data.messages[index] = record.message
                    session.messageOwners.set(record.message.id, record.branchId)
                    session.info = { ...session.info, updatedAt: Math.max(session.info.updatedAt, record.message.createdAt) }
                    break
                }
                case SessionRecordType.Compaction: {
                    const data = requireBranch(session, record.branchId)
                    const checkpoint = record.checkpoint
                    assertOwner(session.checkpointOwners, checkpoint.id, record.branchId)
                    const previous = data.checkpoints.find((item) => item.id === checkpoint.id)
                    if (previous && !isDeepStrictEqual(previous, checkpoint)
                        && [...session.branches.values()].some((item) => item.branch.inheritedCheckpointId === checkpoint.id)) {
                        throw new Error(`Checkpoint ${checkpoint.id} is inherited by a child branch`)
                    }
                    warnCheckpoint(recordIndex, checkpoint, resolveBranchContext(session.branches, record.branchId).messages)
                    data.checkpoints = data.checkpoints.filter((item) => item.id !== checkpoint.id)
                    data.checkpoints.push(checkpoint)
                    session.checkpointOwners.set(checkpoint.id, record.branchId)
                    session.checkpointRecords.set(checkpoint.id, recordIndex)
                    break
                }
                case SessionRecordType.FileChangeProposal:
                    session.proposals.set(record.proposal.id, record.proposal)
                    break
            }
        } catch (cause) {
            throw new SessionReplayError(recordIndex, cause)
        }
    }

    const archives: ISessionArchive[] = []
    for (const session of sessions.values()) {
        for (const [branchId, data] of session.branches) {
            const context = resolveBranchContext(session.branches, branchId)
            for (const checkpoint of data.checkpoints) {
                warnCheckpoint(session.checkpointRecords.get(checkpoint.id)!, checkpoint, context.messages)
            }
        }
        archives.push({ info: session.info, activeBranchId: session.activeBranchId,
            branches: [...session.branches.values()], fileChangeProposals: [...session.proposals.values()] })
    }
    return { archives, warnings: [...warnings.values()].sort((a, b) => a.recordIndex - b.recordIndex) }
}

function requireBranch(session: IReplaySession, branchId: string): IReplayBranch {
    const data = session.branches.get(branchId)
    if (!data) throw new Error(`Branch does not exist: ${branchId}`)
    return data
}

function assertOwner(owners: ReadonlyMap<string, string>, id: string, branchId: string): void {
    const owner = owners.get(id)
    if (owner !== undefined && owner !== branchId) throw new Error(`ID ${id} belongs to another branch`)
}

function assertMessageUnshared(session: IReplaySession, branchId: string, messageIndex: number): void {
    const data: ISessionBranchData = requireBranch(session, branchId)
    for (const child of session.branches.values()) {
        if (child.branch.origin?.branchId !== branchId) continue
        const anchorIndex = data.messages.findIndex((item) => item.id === child.branch.origin!.throughMessageId)
        if (messageIndex <= anchorIndex) throw new Error("Message is inherited by a child branch")
    }
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
