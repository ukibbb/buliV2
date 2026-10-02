import type { Database, SQLQueryBindings } from "bun:sqlite"
import { MAIN_BRANCH_ID } from "@/sessions/branches"

export interface IBranchMetadata {
    readonly id: string
    readonly parent_branch_id: string | null
    readonly fork_message_id: string | null
    readonly inherited_checkpoint_id: string | null
    readonly fork_owner_branch_id: string | null
    readonly fork_message_order: bigint | null
    readonly checkpoint_owner_branch_id: string | null
}

export interface IBranchHistoryRange {
    readonly branchId: string
    readonly throughMessageOrder: bigint | null
}

export interface IResolvedBranchHistory {
    readonly sessionId: string
    readonly branchId: string
    readonly chain: readonly IBranchMetadata[]
    readonly ranges: readonly IBranchHistoryRange[]
}

/** Reads branch metadata once; never fetches a message or checkpoint payload. */
export function resolveBranchHistory(db: Database, sessionId: string, branchId: string): IResolvedBranchHistory {
    const rows = db.query<IBranchMetadata, [string]>(`
        SELECT b.id, b.parent_branch_id, b.fork_message_id, b.inherited_checkpoint_id,
               m.branch_id AS fork_owner_branch_id, m.message_order AS fork_message_order,
               c.branch_id AS checkpoint_owner_branch_id
        FROM branches b
        LEFT JOIN messages m ON m.session_id = b.session_id AND m.id = b.fork_message_id
        LEFT JOIN checkpoints c ON c.session_id = b.session_id AND c.id = b.inherited_checkpoint_id
        WHERE b.session_id = ?`).all(sessionId)
    const branches = new Map(rows.map((row) => [row.id, row]))
    const visited = new Set<string>()
    const chain: IBranchMetadata[] = []
    let current: string | null = branchId
    while (current !== null) {
        if (visited.has(current)) throw new Error(`Branch cycle at ${current}`)
        visited.add(current)
        const row = branches.get(current)
        if (!row) throw new Error(`Branch does not exist: ${current}`)
        if ((row.id === MAIN_BRANCH_ID) !== (row.parent_branch_id === null)) {
            throw new Error("Only the main branch may have no parent")
        }
        chain.push(row)
        current = row.parent_branch_id
    }
    chain.reverse()
    let ranges: IBranchHistoryRange[] = []
    const ancestors = new Set<string>()
    for (const branch of chain) {
        if (branch.parent_branch_id !== null) {
            ranges = inheritedRanges(ranges, branch)
        }
        if (branch.inherited_checkpoint_id !== null
            && (branch.checkpoint_owner_branch_id === null || !ancestors.has(branch.checkpoint_owner_branch_id))) {
            throw new Error(`Invalid inherited checkpoint for branch ${branch.id}`)
        }
        ranges.push({ branchId: branch.id, throughMessageOrder: null })
        ancestors.add(branch.id)
    }
    return { sessionId, branchId, chain, ranges }
}

function inheritedRanges(ranges: readonly IBranchHistoryRange[], branch: IBranchMetadata): IBranchHistoryRange[] {
    if (branch.fork_message_id === null) return []
    const index = ranges.findIndex((range) => range.branchId === branch.fork_owner_branch_id)
    const owner = ranges[index]
    const order = branch.fork_message_order
    if (!owner || order === null || (owner.throughMessageOrder !== null && order > owner.throughMessageOrder)) {
        throw new Error(`Invalid fork message ${branch.fork_message_id} for branch ${branch.id}`)
    }
    return [...ranges.slice(0, index), { branchId: owner.branchId, throughMessageOrder: order }]
}

export function visibleMessage(
    db: Database, history: IResolvedBranchHistory, messageId: string,
): { readonly messageOrder: bigint; readonly rangeIndex: number } {
    const result = findVisibleMessage(db, history, messageId)
    if (!result) throw new Error(`Message is not visible on branch ${history.branchId}: ${messageId}`)
    return result
}

export function findVisibleMessage(
    db: Database, history: IResolvedBranchHistory, messageId: string,
): { readonly messageOrder: bigint; readonly rangeIndex: number } | undefined {
    const row = db.query<{ branch_id: string; message_order: bigint }, [string, string]>(
        "SELECT branch_id, message_order FROM messages WHERE session_id = ? AND id = ?",
    ).get(history.sessionId, messageId)
    const rangeIndex = history.ranges.findIndex((range) => range.branchId === row?.branch_id)
    const range = history.ranges[rangeIndex]
    if (!row || !range || (range.throughMessageOrder !== null && row.message_order > range.throughMessageOrder)) {
        return undefined
    }
    return { messageOrder: row.message_order, rangeIndex }
}

export function rangeWhere(sessionId: string, range: IBranchHistoryRange): {
    readonly sql: string
    readonly bindings: SQLQueryBindings[]
} {
    const bindings: SQLQueryBindings[] = [sessionId, range.branchId]
    let sql = "session_id = ? AND branch_id = ?"
    if (range.throughMessageOrder !== null) {
        sql += " AND message_order <= ?"
        bindings.push(range.throughMessageOrder)
    }
    return { sql, bindings }
}
