import type { Database } from "bun:sqlite"
import { describe, expect, spyOn, test } from "bun:test"
import type { IAssistantMessage, IUserMessage } from "@/agent"
import type { TStoredMessage } from "@/sessions/history-contracts"
import { resolveBranchHistory } from "@/sessions/sqlite/branch-history"
import { checkpointFits, readRequiredContext, saveCheckpoint } from "@/sessions/sqlite/checkpoint-repository"
import { HistoryDatabase } from "@/sessions/sqlite/database"
import { readHistoryPage } from "@/sessions/sqlite/history-reader"
import { appendStoredMessage } from "@/sessions/sqlite/message-repository"
import { recoverInterruptedTools } from "@/sessions/sqlite/recovery-repository"

const user = (id: string): IUserMessage => ({ id, sessionId: "s", runId: "r", role: "user", source: "prompt", content: id, createdAt: 2 })
const assistant = (id: string, calls = 0): IAssistantMessage => ({ id, sessionId: "s", runId: "r", role: "assistant", stopReason: "stop", createdAt: 3,
    content: calls ? Array.from({ length: calls }, (_, index) => ({ type: "toolCall", toolCallId: `${id}-${index}`, toolName: "test", input: {} }))
        : [{ type: "text", text: "answer" }] })
const result = (id: string, owner: string, index = 0): TStoredMessage => ({ id, sessionId: "s", runId: "r", role: "toolResult", assistantMessageId: owner,
    toolCallId: `${owner}-${index}`, toolName: "test", content: "result", isError: false, createdAt: 4 })

function fixture(run: (database: HistoryDatabase) => void): void {
    const database = new HistoryDatabase(":memory:")
    try {
        database.write((db) => {
            db.exec("INSERT INTO sessions VALUES ('s', 'buli', 'Title', 1, 1, 'main')")
            db.exec("INSERT INTO branches VALUES ('s', 'main', NULL, NULL, NULL)")
        })
        run(database)
    } finally { database.close() }
}
function append(db: Database, message: TStoredMessage, branch = "main"): void {
    appendStoredMessage(db, resolveBranchHistory(db, "s", branch), message)
}

describe("SQLite history integrity", () => {
    test("rolls assistant, call rows, and metadata back together before execution", () => fixture((database) => {
        expect(() => database.write((db) => {
            append(db, assistant("a", 2))
            expect(db.query("SELECT count(*) AS count FROM tool_calls").get()).toEqual({ count: 2n })
            throw new Error("after relation insert")
        })).toThrow("after relation insert")
        database.read((db) => {
            expect(db.query("SELECT count(*) AS count FROM messages").get()).toEqual({ count: 0n })
            expect(db.query("SELECT count(*) AS count FROM tool_calls").get()).toEqual({ count: 0n })
            expect(db.query("SELECT updated_at FROM sessions").get()).toEqual({ updated_at: 1n })
        })
    }))

    test("does not reorder or change metadata for an identical retry", () => fixture((database) => {
        const message = assistant("a", 1)
        database.write((db) => append(db, message))
        const read = (db: Database) => ({
            message: db.query("SELECT message_order, created_at FROM messages").get(),
            calls: db.query("SELECT * FROM tool_calls").all(),
            session: db.query("SELECT * FROM sessions").get(),
        })
        const before = database.read(read)
        database.write((db) => append(db, JSON.parse(JSON.stringify(message)) as TStoredMessage))
        expect(database.read(read)).toEqual(before)
    }))

    test("rejects payload, call identity, name, index, and run mismatches", () => {
        const alterations = [
            "UPDATE messages SET payload_json = json_set(payload_json, '$.runId', 'other') WHERE id = 'a'",
            "UPDATE tool_calls SET tool_name = 'changed'",
            "UPDATE tool_calls SET tool_call_id = 'changed'",
            "UPDATE tool_calls SET tool_call_index = 4",
            "UPDATE messages SET payload_json = json_set(payload_json, '$.content[0].toolCallId', 'changed') WHERE id = 'a'",
        ]
        for (const sql of alterations) fixture((database) => {
            database.write((db) => { append(db, assistant("a", 1)); db.exec(sql) })
            expect(() => database.read((db) => readHistoryPage(db, resolveBranchHistory(db, "s", "main")))).toThrow("disagrees")
            expect(() => database.read((db) => readRequiredContext(db, resolveBranchHistory(db, "s", "main")))).toThrow("disagrees")
            expect(() => database.write((db) => recoverInterruptedTools(db, resolveBranchHistory(db, "s", "main")))).toThrow("disagrees")
        })
    })

    test("propagates database failure instead of treating it as a nonfitting checkpoint", () => fixture((database) => {
        database.write((db) => append(db, user("u")))
        database.read((db) => {
            const history = resolveBranchHistory(db, "s", "main")
            expect(checkpointFits(db, history, "absent", 1n)).toBe(false)
            const spy = spyOn(db, "query").mockImplementation(() => { throw new Error("storage read failure") })
            try { expect(() => checkpointFits(db, history, "u", 1n)).toThrow("storage read failure") }
            finally { spy.mockRestore() }
        })
    }))

    test("blocks corrupt selected summaries but does not read obsolete compacted payloads", () => fixture((database) => {
        database.write((db) => {
            append(db, user("u")); append(db, assistant("a"))
            saveCheckpoint(db, resolveBranchHistory(db, "s", "main"), { id: "cp", sessionId: "s", throughMessageId: "a",
                compactedMessageCount: 2, summary: "complete summary", createdAt: 4, reason: "manual" })
            db.exec("UPDATE messages SET payload_json = '{}' WHERE id = 'u'")
            append(db, user("suffix"))
        })
        expect(database.read((db) => readRequiredContext(db, resolveBranchHistory(db, "s", "main")))).toMatchObject({
            contextSummary: "complete summary", messages: [user("suffix")],
        })
        database.write((db) => db.exec("UPDATE checkpoints SET payload_json = '{}'"))
        expect(() => database.read((db) => readRequiredContext(db, resolveBranchHistory(db, "s", "main")))).toThrow("Invalid compaction checkpoint")
    }))

    test("preserves whole groups across ranges and permits different sibling results for the same call", () => fixture((database) => {
        database.write((db) => {
            append(db, user("u")); append(db, assistant("a", 300))
            db.exec("INSERT INTO branches VALUES ('s', 'side', 'main', 'a', NULL)")
            for (let index = 0; index < 300; index++) {
                append(db, result(`main-${index}`, "a", index))
                append(db, result(`side-${index}`, "a", index), "side")
            }
            for (let index = 0; index < 800; index++) append(db, user(`u${index}`), "side")
        })
        database.read((db) => {
            const history = resolveBranchHistory(db, "s", "side")
            const latest = readHistoryPage(db, history)
            expect(latest.messages).toHaveLength(500)
            expect(latest.messages[0]?.id).toBe("u300")
            expect(latest.messages.at(-1)?.id).toBe("u799")
            expect(latest.olderCursor).toBeDefined()
            const middle = readHistoryPage(db, history, latest.olderCursor)
            expect(middle.messages).toHaveLength(300)
            expect(middle.messages[0]?.id).toBe("u0")
            expect(middle.messages.at(-1)?.id).toBe("u299")
            expect(middle.olderCursor).toBeDefined()
            const older = readHistoryPage(db, history, middle.olderCursor)
            expect(older.messages).toHaveLength(302)
            expect(older.olderCursor).toBeUndefined()
            expect(older.messages[1]?.id).toBe("a")
            expect(older.messages.at(-1)?.id).toBe("side-299")
            expect(older.messages.some((message) => message.id.startsWith("main-"))).toBe(false)
            expect(readRequiredContext(db, history).messages).toHaveLength(1_102)
        })
    }))

    test("rejects an interrupted interior turn instead of healing across later messages", () => fixture((database) => {
        database.write((db) => {
            append(db, assistant("a", 1))
            const message = user("later")
            db.query(`INSERT INTO messages (session_id, branch_id, id, run_id, created_at, role, stop_reason,
                provider_visible, assistant_message_id, tool_call_id, payload_json) VALUES ('s', 'main', 'later', 'r', 2, 'user', NULL, 0, NULL, NULL, ?)`)
                .run(JSON.stringify(message))
        })
        expect(() => database.write((db) => recoverInterruptedTools(db, resolveBranchHistory(db, "s", "main")))).toThrow("Invalid tool sequence")
        expect(database.read((db) => db.query("SELECT count(*) AS count FROM messages").get())).toEqual({ count: 2n })
    }))

    test("resolves ancestor anchors and null forks and rejects cycles without recursion", () => fixture((database) => {
        database.write((db) => {
            append(db, user("A")); append(db, user("B"))
            db.exec("INSERT INTO branches VALUES ('s', 'side', 'main', 'B', NULL)")
            append(db, user("X"), "side")
            db.exec("INSERT INTO branches VALUES ('s', 'nested', 'side', 'A', NULL)")
            db.exec("INSERT INTO branches VALUES ('s', 'empty', 'nested', NULL, NULL)")
            append(db, user("P"), "nested"); append(db, user("E"), "empty")
        })
        database.read((db) => {
            expect(readRequiredContext(db, resolveBranchHistory(db, "s", "nested")).messages.map((message) => message.id)).toEqual(["A", "P"])
            expect(readRequiredContext(db, resolveBranchHistory(db, "s", "empty")).messages.map((message) => message.id)).toEqual(["E"])
        })
        database.write((db) => db.exec("UPDATE branches SET parent_branch_id = 'nested' WHERE id = 'side'"))
        expect(() => database.read((db) => resolveBranchHistory(db, "s", "side"))).toThrow("cycle")
    }))
})
