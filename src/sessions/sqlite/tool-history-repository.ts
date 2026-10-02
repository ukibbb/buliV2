import type { Database, SQLQueryBindings } from "bun:sqlite"
import { USER_PATH_REFERENCES_PER_SESSION_MAX, type IUserPathReference } from "@/agent"
import type { TStoredMessage } from "@/sessions/history-contracts"
import { rangeWhere, type IResolvedBranchHistory } from "@/sessions/sqlite/branch-history"
import { messageMetadata, readSelectedPayloads, type IMessageMetadata } from "@/sessions/sqlite/history-reader"
import { assertUserPathReferences } from "@/sessions/validation"

/** Independent of compaction: the two latest users and only assistants between them. */
export function readRecentConversation(db: Database, history: IResolvedBranchHistory): readonly TStoredMessage[] {
    const users: IMessageMetadata[] = []
    for (const row of messageMetadata(db, history, "DESC", undefined, undefined, "user", 2)) {
        users.push(row)
        if (users.length === 2) break
    }
    const current = users[0]
    const previous = users[1]
    if (!current) return []
    if (!previous) return readSelectedPayloads(db, history.sessionId, [current])
    const selected = [previous]
    for (const row of messageMetadata(db, history, "ASC", current.id, previous.id, "assistant")) selected.push(row)
    selected.push(current)
    return readSelectedPayloads(db, history.sessionId, selected)
}

interface IReferencesRow {
    readonly message_order: bigint
    readonly references_json: string | null
}

const REFERENCE_BATCH_SIZE = 128

/** Reads reference JSON only, not user text, image attachments, or compacted message payloads. */
export function readSelectedPaths(db: Database, history: IResolvedBranchHistory): readonly IUserPathReference[] {
    const newest: IUserPathReference[] = []
    const seen = new Set<string>()
    for (const range of [...history.ranges].reverse()) {
        const where = rangeWhere(history.sessionId, range)
        let before: bigint | undefined
        while (true) {
            const bindings: SQLQueryBindings[] = [...where.bindings]
            if (before !== undefined) bindings.push(before)
            bindings.push(REFERENCE_BATCH_SIZE)
            const rows = db.query<IReferencesRow, SQLQueryBindings[]>(`
                SELECT message_order, json_extract(payload_json, '$.references') AS references_json
                FROM messages WHERE ${where.sql} AND role = 'user'
                    ${before === undefined ? "" : "AND message_order < ?"}
                ORDER BY message_order DESC LIMIT ?`,
            ).all(...bindings)
            for (const row of rows) {
                if (row.references_json === null) continue
                const references: unknown = JSON.parse(row.references_json)
                assertUserPathReferences(references)
                for (const reference of [...(references ?? [])].reverse()) {
                    const key = `${reference.kind}\0${reference.path}`
                    if (seen.has(key)) continue
                    seen.add(key)
                    newest.push(reference)
                    if (newest.length === USER_PATH_REFERENCES_PER_SESSION_MAX) return newest.reverse()
                }
            }
            if (rows.length < REFERENCE_BATCH_SIZE) break
            before = rows.at(-1)!.message_order
        }
    }
    return newest.reverse()
}
