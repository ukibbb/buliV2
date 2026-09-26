import { MAIN_BRANCH_ID, validateSessionBranches, type ISessionBranchData } from "@/sessions/branches"
import { SessionRecordType as Kind, assertSessionRecord, type TSessionRecord } from "@/sessions/jsonl/session-records"
import type { ISessionArchive } from "@/sessions/repository"

export function sessionArchiveRecords(archive: ISessionArchive): readonly TSessionRecord[] {
    const branches = new Map(archive.branches.map((data) => [data.branch.id, data]))
    if (branches.size !== archive.branches.length) throw new Error("Duplicate branch ID")
    validateSessionBranches(archive.info.id, branches)
    if (!branches.has(archive.activeBranchId)) throw new Error("Invalid active branch")
    const children = new Map<string, ISessionBranchData[]>()
    for (const data of branches.values()) {
        const parent = data.branch.origin?.branchId
        if (parent === undefined) continue
        const siblings = children.get(parent) ?? []
        siblings.push(data)
        children.set(parent, siblings)
    }
    const records: TSessionRecord[] = [{ recordType: Kind.Session, session: archive.info }]
    const pending = [branches.get(MAIN_BRANCH_ID)!]
    while (pending.length > 0) {
        const data = pending.pop()!
        const branchId = data.branch.id
        if (branchId !== MAIN_BRANCH_ID) {
            records.push({ recordType: Kind.Branch, sessionId: archive.info.id, branch: data.branch })
        }
        for (const message of data.messages) records.push({ recordType: Kind.Message, branchId, message })
        for (const checkpoint of data.checkpoints) records.push({ recordType: Kind.Compaction, branchId, checkpoint })
        const descendants = children.get(branchId) ?? []
        for (let i = descendants.length - 1; i >= 0; i--) pending.push(descendants[i]!)
    }
    const proposalIds = new Set<string>()
    for (const proposal of archive.fileChangeProposals) {
        if (proposal.sessionId !== archive.info.id || proposalIds.has(proposal.id)) {
            throw new Error("Invalid archive proposal ownership or duplicate ID")
        }
        proposalIds.add(proposal.id)
        records.push({ recordType: Kind.FileChangeProposal, proposal })
    }
    records.push({ recordType: Kind.BranchSelection, sessionId: archive.info.id, branchId: archive.activeBranchId })
    for (const record of records) assertSessionRecord(record)
    return structuredClone(records)
}
