import type { Database, SQLQueryBindings } from "bun:sqlite"
import { isDeepStrictEqual } from "node:util"
import type { TAppendMessageResult, TStoredMessage } from "@/sessions/history-contracts"
import { rangeWhere, visibleMessage, type IResolvedBranchHistory } from "@/sessions/sqlite/branch-history"
import { assertSafeInteger } from "@/sessions/sqlite/database"
import { assertStoredMessage, isProviderVisible, readLastMessageMetadata, readVisibleMessage } from "@/sessions/sqlite/history-reader"

/** Called within the owner's short write transaction, before context acceptance or tool execution. */
export function appendStoredMessage(db: Database, history: IResolvedBranchHistory, message: TStoredMessage): TAppendMessageResult {
    assertStoredMessage(message)
    assertSafeInteger(message.createdAt, "message.createdAt")
    if (message.sessionId !== history.sessionId) throw new Error("Message belongs to another session")
    const existing = db.query<{ branch_id: string; payload_json: string }, [string, string]>(
        "SELECT branch_id, payload_json FROM messages WHERE session_id = ? AND id = ?",
    ).get(message.sessionId, message.id)
    if (existing) {
        if (existing.branch_id !== history.branchId || !isDeepStrictEqual(JSON.parse(existing.payload_json), message)) {
            throw new Error(`Conflicting immutable message ID: ${message.id}`)
        }
        readVisibleMessage(db, history, message.id)
        return { kind: "unchanged" }
    }
    assertAppendSequence(db, history, message)
    db.query(`INSERT INTO messages (session_id, branch_id, id, run_id, created_at, role,
        stop_reason, provider_visible, assistant_message_id, tool_call_id, payload_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(message.sessionId, history.branchId, message.id, message.runId, message.createdAt, message.role,
            message.role === "assistant" ? message.stopReason : null, isProviderVisible(message) ? 1 : 0,
            message.role === "toolResult" ? message.assistantMessageId : null,
            message.role === "toolResult" ? message.toolCallId : null, JSON.stringify(message))
    if (message.role === "assistant") {
        const calls = message.content.filter((part) => part.type === "toolCall")
        for (const [index, call] of calls.entries()) {
            db.query(`INSERT INTO tool_calls (session_id, assistant_message_id, tool_call_id, tool_call_index, tool_name)
                VALUES (?, ?, ?, ?, ?)`)
                .run(message.sessionId, message.id, call.toolCallId, index, call.toolName)
        }
    }
    db.query("UPDATE sessions SET updated_at = max(updated_at, ?) WHERE id = ?").run(message.createdAt, message.sessionId)
    return { kind: "inserted" }
}

function assertAppendSequence(db: Database, history: IResolvedBranchHistory, message: TStoredMessage): void {
    const tail = readLastMessageMetadata(db, history)
    const assistantId = tail?.role === "assistant" ? tail.id : tail?.assistant_message_id
    const assistant = assistantId ? db.query<{ run_id: string; role: string; stop_reason: string }, [string, string]>(
        "SELECT run_id, role, stop_reason FROM messages WHERE session_id = ? AND id = ?",
    ).get(history.sessionId, assistantId) : null
    let missing = 0n
    if (assistant && assistant.stop_reason !== "aborted" && assistant.stop_reason !== "error") {
        const calls = db.query<{ count: bigint }, [string, string]>(
            "SELECT count(*) AS count FROM tool_calls WHERE session_id = ? AND assistant_message_id = ?",
        ).get(history.sessionId, assistantId!)!.count
        missing = calls - visibleResultCount(db, history, assistantId!)
        if (missing < 0n) throw new Error("Duplicate durable tool results")
    }
    if (message.role !== "toolResult") {
        if (missing > 0n) throw new Error("Cannot append a message before completing the pending tool group")
        return
    }
    visibleMessage(db, history, message.assistantMessageId)
    if (assistantId !== message.assistantMessageId || !assistant || assistant.role !== "assistant"
        || assistant.run_id !== message.runId || missing === 0n) {
        throw new Error("Tool result does not complete the visible pending assistant")
    }
    const call = db.query<{ tool_name: string }, [string, string, string]>(
        "SELECT tool_name FROM tool_calls WHERE session_id = ? AND assistant_message_id = ? AND tool_call_id = ?",
    ).get(history.sessionId, message.assistantMessageId, message.toolCallId)
    if (!call || call.tool_name !== message.toolName) throw new Error("Tool result does not match its call")
    if (visibleResultCount(db, history, message.assistantMessageId, message.toolCallId) > 0n) {
        throw new Error("Duplicate visible tool result")
    }
}

function visibleResultCount(db: Database, history: IResolvedBranchHistory, assistantId: string, callId?: string): bigint {
    let count = 0n
    for (const range of history.ranges) {
        const where = rangeWhere(history.sessionId, range)
        where.bindings.push(assistantId)
        if (callId !== undefined) where.bindings.push(callId)
        count += db.query<{ count: bigint }, SQLQueryBindings[]>(
            `SELECT count(*) AS count FROM messages WHERE ${where.sql} AND assistant_message_id = ?${callId === undefined ? "" : " AND tool_call_id = ?"}`,
        ).get(...where.bindings)!.count
    }
    return count
}
