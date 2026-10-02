import type { Database, SQLQueryBindings } from "bun:sqlite"
import type { TAgentMessage } from "@/agent"
import { HISTORY_MESSAGE_TARGET, type IHistoryCursor, type IHistoryPage, type TStoredMessage } from "@/sessions/history-contracts"
import { rangeWhere, visibleMessage, type IResolvedBranchHistory } from "@/sessions/sqlite/branch-history"
import { safeNumber } from "@/sessions/sqlite/database"
import { assertDurableSessionMessage } from "@/sessions/validation"

const METADATA_BATCH_SIZE = 256

export interface IMessageMetadata {
    readonly message_order: bigint
    readonly id: string
    readonly branch_id: string
    readonly run_id: string
    readonly created_at: bigint
    readonly role: TAgentMessage["role"]
    readonly stop_reason: string | null
    readonly provider_visible: bigint
    readonly assistant_message_id: string | null
    readonly tool_call_id: string | null
    readonly tool_count: bigint
    readonly tool_name: string | null
    readonly owner_run_id: string | null
}

const METADATA_SELECT = `SELECT m.message_order, m.id, m.branch_id, m.run_id, m.created_at, m.role,
    m.stop_reason, m.provider_visible, m.assistant_message_id, m.tool_call_id,
    (SELECT count(*) FROM tool_calls tc WHERE tc.session_id = m.session_id
        AND tc.assistant_message_id = m.id) AS tool_count,
    call.tool_name, owner.run_id AS owner_run_id
    FROM messages m
    LEFT JOIN tool_calls call ON call.session_id = m.session_id
        AND call.assistant_message_id = m.assistant_message_id AND call.tool_call_id = m.tool_call_id
    LEFT JOIN messages owner ON owner.session_id = m.session_id AND owner.id = m.assistant_message_id`

/** Bounded metadata batches; the generator never retains the visited archive. */
export function* messageMetadata(
    db: Database,
    history: IResolvedBranchHistory,
    direction: "ASC" | "DESC" = "ASC",
    beforeMessageId?: string,
    afterMessageId?: string,
    role?: TAgentMessage["role"],
    batchSize = METADATA_BATCH_SIZE,
): Generator<IMessageMetadata> {
    if (!Number.isSafeInteger(batchSize) || batchSize <= 0) throw new Error("Metadata batch size must be a positive safe integer")
    const boundary = beforeMessageId === undefined ? undefined : visibleMessage(db, history, beforeMessageId)
    const start = afterMessageId === undefined ? undefined : visibleMessage(db, history, afterMessageId)
    const indices = history.ranges.map((_, index) => index)
    if (direction === "DESC") indices.reverse()
    for (const index of indices) {
        if ((boundary && index > boundary.rangeIndex) || (start && index < start.rangeIndex)) continue
        const range = history.ranges[index]!
        const where = rangeWhere(history.sessionId, range)
        let last: bigint | undefined
        while (true) {
            let sql = where.sql.replace(/\b(session_id|branch_id|message_order)\b/g, "m.$1")
            const bindings: SQLQueryBindings[] = [...where.bindings]
            if (role !== undefined) {
                sql += " AND m.role = ?"
                bindings.push(role)
            }
            if (boundary && index === boundary.rangeIndex) {
                sql += " AND m.message_order < ?"
                bindings.push(boundary.messageOrder)
            }
            if (start && index === start.rangeIndex) {
                sql += " AND m.message_order > ?"
                bindings.push(start.messageOrder)
            }
            if (last !== undefined) {
                sql += ` AND m.message_order ${direction === "ASC" ? ">" : "<"} ?`
                bindings.push(last)
            }
            bindings.push(batchSize)
            const rows = db.query<IMessageMetadata, SQLQueryBindings[]>(
                `${METADATA_SELECT} WHERE ${sql} ORDER BY m.message_order ${direction} LIMIT ?`,
            ).all(...bindings)
            if (rows.length === 0) break
            yield* rows
            last = rows.at(-1)!.message_order
            if (rows.length < batchSize) break
        }
    }
}

/** Reads only the tail row, including inherited history when the local branch is empty. */
export function readLastMessageMetadata(db: Database, history: IResolvedBranchHistory): IMessageMetadata | undefined {
    const iterator = messageMetadata(db, history, "DESC", undefined, undefined, undefined, 1)
    try { return iterator.next().value } finally { iterator.return(undefined) }
}

export interface IHistoryValidation {
    readonly messageCount: number
    readonly eligibleCount: number
    readonly pendingAssistantId?: string
    readonly pendingToolCallIds?: ReadonlySet<string>
    readonly completeAnchors: ReadonlyMap<string, number>
}

/** Validates the sequence using relations only; payloads are not needed for the compacted prefix. */
export function validateHistory(
    db: Database, history: IResolvedBranchHistory, anchorIds: ReadonlySet<string> = new Set(),
): IHistoryValidation {
    let count = 0
    let firstUnprocessedUser: number | undefined
    let pending: { id: string; runId: string; remaining: Set<string> } | undefined
    const anchors = new Map<string, number>()
    for (const row of messageMetadata(db, history)) {
        if (pending) {
            if (row.role !== "toolResult" || row.assistant_message_id !== pending.id
                || row.run_id !== pending.runId || row.tool_call_id === null
                || !pending.remaining.delete(row.tool_call_id) || row.tool_name === null) {
                throw new Error(`Invalid tool sequence in session ${history.sessionId}`)
            }
            if (pending.remaining.size === 0) pending = undefined
        } else if (row.role === "toolResult") {
            throw new Error(`Tool result has no preceding tool call in session ${history.sessionId}`)
        } else if (row.role === "assistant" && row.stop_reason !== "error" && row.stop_reason !== "aborted"
            && row.tool_count > 0n) {
            const calls = db.query<{ tool_call_id: string }, [string, string]>(
                "SELECT tool_call_id FROM tool_calls WHERE session_id = ? AND assistant_message_id = ? ORDER BY tool_call_index",
            ).all(history.sessionId, row.id)
            pending = { id: row.id, runId: row.run_id, remaining: new Set(calls.map((call) => call.tool_call_id)) }
        }
        if (row.provider_visible === 1n) firstUnprocessedUser = undefined
        if (row.role === "user" && firstUnprocessedUser === undefined) firstUnprocessedUser = count
        count++
        if (!Number.isSafeInteger(count)) throw new Error("History length exceeds safe integer range")
        if (!pending && anchorIds.has(row.id)) anchors.set(row.id, count)
    }
    return {
        messageCount: count,
        eligibleCount: firstUnprocessedUser ?? count,
        completeAnchors: anchors,
        ...(pending === undefined ? {} : { pendingAssistantId: pending.id, pendingToolCallIds: pending.remaining }),
    }
}

export function readHistoryPage(
    db: Database, history: IResolvedBranchHistory, cursor?: IHistoryCursor,
): IHistoryPage {
    if (cursor && (cursor.sessionId !== history.sessionId || cursor.branchId !== history.branchId)) {
        throw new Error("History cursor belongs to another session or branch")
    }
    if (cursor) {
        const boundary = db.query<{ role: string }, [string, string]>(
            "SELECT role FROM messages WHERE session_id = ? AND id = ?",
        ).get(history.sessionId, cursor.beforeMessageId)
        if (boundary?.role === "toolResult") throw new Error("History cursor splits a tool group")
    }
    const selected: IMessageMetadata[][] = []
    let count = 0
    let older = false
    for (const group of reverseGroups(messageMetadata(db, history, "DESC", cursor?.beforeMessageId))) {
        if (count > 0 && count + group.length > HISTORY_MESSAGE_TARGET) {
            older = true
            break
        }
        selected.push(group)
        count += group.length
    }
    const metadata = selected.reverse().flatMap((group) => group.reverse())
    const messages = readSelectedPayloads(db, history.sessionId, metadata)
    const first = messages[0]
    return {
        sessionId: history.sessionId, branchId: history.branchId, messages,
        ...(older && first ? { olderCursor: { sessionId: history.sessionId, branchId: history.branchId, beforeMessageId: first.id } } : {}),
    }
}

function* reverseGroups(rows: Iterable<IMessageMetadata>): Generator<IMessageMetadata[]> {
    let group: IMessageMetadata[] = []
    let owner: string | undefined
    for (const row of rows) {
        if (owner !== undefined) {
            if (row.role === "toolResult" && row.assistant_message_id === owner) {
                group.push(row)
                continue
            }
            if (row.role !== "assistant" || row.id !== owner) throw new Error("Invalid tool group in history page")
            group.push(row)
            yield group
            group = []
            owner = undefined
            continue
        }
        if (row.role === "toolResult") {
            if (row.assistant_message_id === null) throw new Error("Tool result has no owner")
            owner = row.assistant_message_id
            group = [row]
        } else {
            yield [row]
        }
    }
    if (owner !== undefined) throw new Error("History page ends inside a tool group")
}

export function readVisibleMessage(db: Database, history: IResolvedBranchHistory, id: string): TStoredMessage {
    visibleMessage(db, history, id)
    const row = db.query<IMessageMetadata, [string, string]>(
        `${METADATA_SELECT} WHERE m.session_id = ? AND m.id = ?`,
    ).get(history.sessionId, id)
    if (!row) throw new Error(`Missing durable message: ${id}`)
    return readSelectedPayloads(db, history.sessionId, [row])[0]!
}

export function readSelectedPayloads(db: Database, sessionId: string, rows: readonly IMessageMetadata[]): TStoredMessage[] {
    const result: TStoredMessage[] = []
    for (let offset = 0; offset < rows.length; offset += METADATA_BATCH_SIZE) {
        const batch = rows.slice(offset, offset + METADATA_BATCH_SIZE)
        const placeholders = batch.map(() => "?").join(", ")
        const payloads = db.query<{ id: string; payload_json: string }, SQLQueryBindings[]>(
            `SELECT id, payload_json FROM messages WHERE session_id = ? AND id IN (${placeholders})`,
        ).all(sessionId, ...batch.map((row) => row.id))
        const byId = new Map(payloads.map((row) => [row.id, row.payload_json]))
        const messages = batch.map((row) => {
            const payload = byId.get(row.id)
            if (payload === undefined) throw new Error(`Missing durable message: ${row.id}`)
            return decodeMessage(payload, sessionId, row)
        })
        assertToolCallRelations(db, sessionId, messages)
        result.push(...messages)
    }
    return result
}

export function decodeMessage(payload: string, sessionId: string, row: IMessageMetadata): TStoredMessage {
    const value: unknown = JSON.parse(payload)
    assertStoredMessage(value)
    if (value.sessionId !== sessionId || value.id !== row.id || value.role !== row.role
        || value.runId !== row.run_id || value.createdAt !== safeNumber(row.created_at, "createdAt")
        || (value.role === "assistant" && (value.stopReason !== row.stop_reason
            || BigInt(value.content.filter((part) => part.type === "toolCall").length) !== row.tool_count
            || isProviderVisible(value) !== (row.provider_visible === 1n)))
        || (value.role === "toolResult" && (value.assistantMessageId !== row.assistant_message_id
            || value.toolCallId !== row.tool_call_id || value.toolName !== row.tool_name || value.runId !== row.owner_run_id))) {
        throw new Error(`Message payload disagrees with metadata: ${row.id}`)
    }
    return value
}

function assertToolCallRelations(db: Database, sessionId: string, messages: readonly TStoredMessage[]): void {
    const assistants = messages.filter((message) => message.role === "assistant")
        .map((message) => ({ id: message.id, calls: message.content.filter((part) => part.type === "toolCall") }))
        .filter((message) => message.calls.length > 0)
    // decodeMessage already compares the indexed relation count, including zero, with the payload.
    if (assistants.length === 0) return
    const placeholders = assistants.map(() => "?").join(", ")
    const stored = db.query<{ assistant_message_id: string; tool_call_id: string; tool_name: string; tool_call_index: bigint }, SQLQueryBindings[]>(
        `SELECT assistant_message_id, tool_call_id, tool_name, tool_call_index FROM tool_calls
         WHERE session_id = ? AND assistant_message_id IN (${placeholders})`,
    ).all(sessionId, ...assistants.map((message) => message.id))
    const callsByOwner = new Map(assistants.map((message) => [message.id, message.calls]))
    for (const row of stored) {
        const call = callsByOwner.get(row.assistant_message_id)?.[safeNumber(row.tool_call_index, "toolCallIndex")]
        if (!call || row.tool_call_id !== call.toolCallId || row.tool_name !== call.toolName) {
            throw new Error(`Assistant payload disagrees with tool calls: ${row.assistant_message_id}`)
        }
    }
}

export function assertStoredMessage(value: unknown): asserts value is TStoredMessage {
    assertDurableSessionMessage(value)
}

export function isProviderVisible(message: TAgentMessage): boolean {
    return message.role === "assistant" && message.stopReason !== "error" && message.stopReason !== "aborted"
        && message.content.some((part) => part.type === "toolCall" || (part.type === "text" && part.text.length > 0))
}
