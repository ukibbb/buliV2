import type { Database } from "bun:sqlite"
import type { IResolvedBranchHistory } from "@/sessions/sqlite/branch-history"
import { readVisibleMessage, validateHistory } from "@/sessions/sqlite/history-reader"
import { appendStoredMessage } from "@/sessions/sqlite/message-repository"

/** Repairs only the final unfinished group, never re-executing a tool or loading the old archive. */
export function recoverInterruptedTools(db: Database, history: IResolvedBranchHistory): void {
    const validation = validateHistory(db, history)
    if (!validation.pendingAssistantId) return
    const assistant = readVisibleMessage(db, history, validation.pendingAssistantId)
    if (assistant.role !== "assistant") throw new Error("Interrupted tool group has no assistant")
    for (const call of assistant.content) {
        if (call.type !== "toolCall" || !validation.pendingToolCallIds?.has(call.toolCallId)) continue
        appendStoredMessage(db, history, {
            id: recoveryMessageId(db, history.sessionId, assistant.id, call.toolCallId),
            sessionId: history.sessionId,
            runId: assistant.runId,
            role: "toolResult",
            assistantMessageId: assistant.id,
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            content: "A durable tool result was not recorded. The tool may have produced side effects; inspect the current state before retrying.",
            isError: true,
            outcome: "effects-unknown",
            summary: "Tool outcome is unknown; inspect state before retrying",
            createdAt: assistant.createdAt,
        })
    }
}

function recoveryMessageId(db: Database, sessionId: string, assistantId: string, callId: string): string {
    const base = `recovered-${assistantId}-${callId}`
    let id = base
    let suffix = 1
    while (db.query("SELECT 1 FROM messages WHERE session_id = ? AND id = ?").get(sessionId, id)) {
        id = `${base}-${suffix++}`
    }
    return id
}
