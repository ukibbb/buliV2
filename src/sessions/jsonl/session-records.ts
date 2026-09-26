import type { IFileChangeProposalRecord, TAgentMessage } from "@/agent"
import type { ISessionBranch } from "@/sessions/branches"
import type { ICompactionCheckpoint } from "@/sessions/compaction/checkpoint"
import type { ISessionInfo } from "@/sessions/repository"
import {
    assertCompactionCheckpoint,
    assertDurableSessionMessage,
    assertFileChangeProposalRecord,
    assertSessionInfo,
} from "@/sessions/validation"

export const SessionRecordType = {
    Session: "session",
    Message: "message",
    Compaction: "compaction",
    FileChangeProposal: "fileChangeProposal",
    Branch: "branch",
    BranchSelection: "branchSelection",
} as const

export interface ISessionRecord {
    readonly recordType: typeof SessionRecordType.Session
    readonly session: ISessionInfo
}

export interface IMessageRecord {
    readonly recordType: typeof SessionRecordType.Message
    readonly branchId: string
    readonly message: TAgentMessage
}

export interface ICompactionRecord {
    readonly recordType: typeof SessionRecordType.Compaction
    readonly branchId: string
    readonly checkpoint: ICompactionCheckpoint
}

export interface IFileChangeProposalRecordEnvelope {
    readonly recordType: typeof SessionRecordType.FileChangeProposal
    readonly proposal: IFileChangeProposalRecord
}

export interface IBranchRecord {
    readonly recordType: typeof SessionRecordType.Branch
    readonly sessionId: string
    readonly branch: ISessionBranch
}

export interface IBranchSelectionRecord {
    readonly recordType: typeof SessionRecordType.BranchSelection
    readonly sessionId: string
    readonly branchId: string
}

export type TSessionRecord =
    | ISessionRecord
    | IMessageRecord
    | ICompactionRecord
    | IFileChangeProposalRecordEnvelope
    | IBranchRecord
    | IBranchSelectionRecord

/** Validates structure only; tree references and write rules belong to replay. */
export function assertSessionRecord(value: unknown): asserts value is TSessionRecord {
    if (!isRecord(value)) throw new Error("Invalid session record")
    switch (value.recordType) {
        case SessionRecordType.Session:
            assertExactKeys(value, ["recordType", "session"])
            assertExactKeys(value.session, ["id", "agentId", "title", "createdAt", "updatedAt"])
            assertSessionInfo(value.session)
            return
        case SessionRecordType.Message:
            assertExactKeys(value, ["recordType", "branchId", "message"])
            assertId(value.branchId)
            assertDurableSessionMessage(value.message)
            return
        case SessionRecordType.Compaction:
            assertExactKeys(value, ["recordType", "branchId", "checkpoint"])
            assertId(value.branchId)
            assertCompactionCheckpoint(value.checkpoint)
            return
        case SessionRecordType.FileChangeProposal:
            assertExactKeys(value, ["recordType", "proposal"])
            assertFileChangeProposalRecord(value.proposal)
            return
        case SessionRecordType.Branch:
            assertExactKeys(value, ["recordType", "sessionId", "branch"])
            assertId(value.sessionId)
            assertBranch(value.branch)
            return
        case SessionRecordType.BranchSelection:
            assertExactKeys(value, ["recordType", "sessionId", "branchId"])
            assertId(value.sessionId)
            assertId(value.branchId)
            return
        default:
            throw new Error("Unknown session record type")
    }
}

export function parseSessionRecord(line: string): TSessionRecord {
    const value: unknown = JSON.parse(line)
    assertSessionRecord(value)
    return value
}

export function serializeSessionRecords(records: readonly TSessionRecord[]): string {
    const lines = records.map((record) => {
        assertSessionRecord(record)
        return JSON.stringify(record)
    })
    return lines.length === 0 ? "" : `${lines.join("\n")}\n`
}

function assertBranch(value: unknown): asserts value is ISessionBranch {
    assertExactKeys(value, ["id", "origin", "inheritedCheckpointId"])
    assertId(value.id)
    if (value.inheritedCheckpointId !== null) assertId(value.inheritedCheckpointId)
    if (value.origin !== null) {
        assertExactKeys(value.origin, ["branchId", "throughMessageId"])
        assertId(value.origin.branchId)
        if (value.origin.throughMessageId !== null) assertId(value.origin.throughMessageId)
    }
}

function assertId(value: unknown): asserts value is string {
    if (typeof value !== "string" || !value.trim()) {
        throw new Error("Invalid session record identifier")
    }
}

function assertExactKeys(
    value: unknown,
    keys: readonly string[],
): asserts value is Record<string, unknown> {
    if (!isRecord(value)
        || Object.keys(value).length !== keys.length
        || !keys.every((key) => Object.hasOwn(value, key))) {
        throw new Error("Invalid session record fields")
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
}
