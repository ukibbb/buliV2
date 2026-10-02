import type { Database, SQLQueryBindings } from "bun:sqlite"
import type { ICompactionCheckpoint } from "@/sessions/compaction/checkpoint"
import type { IRequiredContext } from "@/sessions/history-contracts"
import { findVisibleMessage, rangeWhere, type IResolvedBranchHistory } from "@/sessions/sqlite/branch-history"
import { assertSafeInteger, safeNumber } from "@/sessions/sqlite/database"
import { messageMetadata, readLastMessageMetadata, readSelectedPayloads, validateHistory, type IMessageMetadata } from "@/sessions/sqlite/history-reader"
import { assertCompactionCheckpoint } from "@/sessions/validation"
import { isDeepStrictEqual } from "node:util"

interface ICheckpointRow {
    readonly id: string
    readonly branch_id: string
    readonly through_message_id: string
    readonly compacted_message_count: bigint
    readonly payload_json: string
}

/** Selection is local newest-first, then the exact inherited checkpoint, never a newer parent summary. */
export function selectedCheckpoint(db: Database, history: IResolvedBranchHistory): ICompactionCheckpoint | undefined {
    let before: bigint | undefined
    while (true) {
        const bindings: SQLQueryBindings[] = [history.sessionId, history.branchId]
        if (before !== undefined) bindings.push(before)
        const rows = db.query<Omit<ICheckpointRow, "payload_json"> & { checkpoint_order: bigint }, SQLQueryBindings[]>(`
            SELECT checkpoint_order, id, branch_id, through_message_id, compacted_message_count FROM checkpoints
            WHERE session_id = ? AND branch_id = ? ${before === undefined ? "" : "AND checkpoint_order < ?"}
            ORDER BY checkpoint_order DESC LIMIT 256`,
        ).all(...bindings)
        for (const row of rows) {
            if (checkpointFits(db, history, row.through_message_id, row.compacted_message_count)) {
                return readCheckpoint(db, history.sessionId, row.id)
            }
        }
        if (rows.length < 256) break
        before = rows.at(-1)!.checkpoint_order
    }
    const inherited = history.chain.at(-1)?.inherited_checkpoint_id
    if (inherited == null) return undefined
    const checkpoint = readCheckpoint(db, history.sessionId, inherited)
    return checkpointFits(db, history, checkpoint.throughMessageId, BigInt(checkpoint.compactedMessageCount))
        ? checkpoint : undefined
}

export function readCheckpoint(db: Database, sessionId: string, id: string): ICompactionCheckpoint {
    const row = db.query<ICheckpointRow, [string, string]>(
        "SELECT id, branch_id, through_message_id, compacted_message_count, payload_json FROM checkpoints WHERE session_id = ? AND id = ?",
    ).get(sessionId, id)
    if (!row) throw new Error(`Missing checkpoint: ${id}`)
    const value: unknown = JSON.parse(row.payload_json)
    assertCompactionCheckpoint(value)
    if (value.id !== id || value.sessionId !== sessionId || value.throughMessageId !== row.through_message_id
        || value.compactedMessageCount !== safeNumber(row.compacted_message_count, "compactedMessageCount")) {
        throw new Error(`Checkpoint payload disagrees with metadata: ${id}`)
    }
    return value
}

export function checkpointFits(db: Database, history: IResolvedBranchHistory, anchorId: string, count: bigint): boolean {
    const anchor = findVisibleMessage(db, history, anchorId)
    if (!anchor) return false
    let actualCount = 0n
    for (const [index, range] of history.ranges.entries()) {
        if (index > anchor.rangeIndex) break
        const where = rangeWhere(history.sessionId, range)
        if (index === anchor.rangeIndex) {
            where.bindings.push(anchor.messageOrder)
        }
        const row = db.query<{ count: bigint }, SQLQueryBindings[]>(
            `SELECT count(*) AS count FROM messages WHERE ${where.sql}${index === anchor.rangeIndex ? " AND message_order <= ?" : ""}`,
        ).get(...where.bindings)!
        actualCount += row.count
    }
    if (actualCount !== count) return false
    const prefix: IResolvedBranchHistory = {
        ...history,
        ranges: history.ranges.slice(0, anchor.rangeIndex + 1).map((range, index) => index === anchor.rangeIndex
            ? { branchId: range.branchId, throughMessageOrder: anchor.messageOrder } : range),
    }
    const last = readLastMessageMetadata(db, prefix)
    if (!last) return false
    const ownerId = last.role === "toolResult" ? last.assistant_message_id : last.role === "assistant" ? last.id : null
    if (ownerId === null) return true
    const owner = db.query<{ stop_reason: string; count: bigint }, [string, string]>(`
        SELECT m.stop_reason, (SELECT count(*) FROM tool_calls t
            WHERE t.session_id = m.session_id AND t.assistant_message_id = m.id) AS count
        FROM messages m WHERE m.session_id = ? AND m.id = ?`,
    ).get(history.sessionId, ownerId)
    if (!owner) throw new Error(`Missing assistant owner: ${ownerId}`)
    if (owner.stop_reason === "aborted" || owner.stop_reason === "error") return last.role !== "toolResult"
    let results = 0n
    for (const range of prefix.ranges) {
        const where = rangeWhere(history.sessionId, range)
        results += db.query<{ count: bigint }, SQLQueryBindings[]>(
            `SELECT count(*) AS count FROM messages WHERE ${where.sql} AND assistant_message_id = ?`,
        ).get(...where.bindings, ownerId)!.count
    }
    return results === owner.count
}

export function saveCheckpoint(db: Database, history: IResolvedBranchHistory, checkpoint: ICompactionCheckpoint): void {
    assertCompactionCheckpoint(checkpoint)
    assertSafeInteger(checkpoint.createdAt, "checkpoint.createdAt")
    assertSafeInteger(checkpoint.compactedMessageCount, "compactedMessageCount")
    if (checkpoint.sessionId !== history.sessionId) throw new Error("Checkpoint belongs to another session")
    const existing = db.query<{ branch_id: string }, [string, string]>(
        "SELECT branch_id FROM checkpoints WHERE session_id = ? AND id = ?",
    ).get(history.sessionId, checkpoint.id)
    if (existing) {
        if (existing.branch_id !== history.branchId || !isDeepStrictEqual(readCheckpoint(db, history.sessionId, checkpoint.id), checkpoint)) {
            throw new Error(`Conflicting immutable checkpoint ID: ${checkpoint.id}`)
        }
        return
    }
    if (!checkpointFits(db, history, checkpoint.throughMessageId, BigInt(checkpoint.compactedMessageCount))) {
        throw new Error("Compaction checkpoint does not match visible history")
    }
    db.query(`INSERT INTO checkpoints (session_id, branch_id, id, through_message_id, compacted_message_count, payload_json)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(history.sessionId, history.branchId, checkpoint.id, checkpoint.throughMessageId,
            checkpoint.compactedMessageCount, JSON.stringify(checkpoint))
}

/** Rebuilds all required content; no UI target is applied to this read. */
export function readRequiredContext(db: Database, history: IResolvedBranchHistory): IRequiredContext {
    const validation = validateHistory(db, history)
    const selected = selectedCheckpoint(db, history)
    const checkpoint = selected && selected.compactedMessageCount <= validation.eligibleCount
        && validation.pendingAssistantId === undefined ? selected : undefined
    const messages: IRequiredContext["messages"][number][] = []
    let batch: IMessageMetadata[] = []
    for (const row of messageMetadata(db, history, "ASC", undefined, checkpoint?.throughMessageId)) {
        batch.push(row)
        if (batch.length === 256) {
            messages.push(...readSelectedPayloads(db, history.sessionId, batch))
            batch = []
        }
    }
    if (batch.length > 0) messages.push(...readSelectedPayloads(db, history.sessionId, batch))
    return { messages, ...(checkpoint ? { checkpoint, contextSummary: checkpoint.summary } : {}) }
}
