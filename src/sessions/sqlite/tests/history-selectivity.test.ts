import type { Database } from "bun:sqlite"
import { expect, spyOn, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveBranchHistory } from "@/sessions/sqlite/branch-history"
import { readRequiredContext, saveCheckpoint, selectedCheckpoint } from "@/sessions/sqlite/checkpoint-repository"
import { HistoryDatabase } from "@/sessions/sqlite/database"
import { readHistoryPage } from "@/sessions/sqlite/history-reader"
import { appendStoredMessage } from "@/sessions/sqlite/message-repository"

const MAIN_MESSAGES = 20_000
const COMPACTED_MESSAGES = 18_000
const SAMPLE_COUNT = 5

/** Few branches, large histories: no hard latency assertion or production performance promise. */
test("uses indexed range and payload lookups for a large temporary history", async () => {
    const directory = await mkdtemp(join(tmpdir(), "buli-sqlite-selectivity-"))
    const database = new HistoryDatabase(join(directory, "sessions.sqlite"))
    try {
        database.write((db) => {
            db.exec("INSERT INTO sessions VALUES ('s', 'buli', 'History', 1, 1, 'main')")
            db.exec("INSERT INTO branches VALUES ('s', 'main', NULL, NULL, NULL)")
            const insert = db.query(`INSERT INTO messages (session_id, branch_id, id, run_id, created_at, role,
                stop_reason, provider_visible, assistant_message_id, tool_call_id, payload_json)
                VALUES ('s', ?, ?, 'r', 2, 'assistant', 'stop', 1, NULL, NULL, ?)`)
            for (let index = 0; index < MAIN_MESSAGES; index++) {
                const id = `m${index}`
                insert.run("main", id, JSON.stringify({ id, sessionId: "s", runId: "r", createdAt: 2, role: "assistant",
                    stopReason: "stop", content: [{ type: "text", text: `${id}: ${"x".repeat(512)}` }] }))
            }
            db.exec("INSERT INTO branches VALUES ('s', 'sibling', 'main', 'm4999', NULL)")
            // These deliberately invalid sibling payloads must never be decoded for main.
            for (let index = 0; index < 2_000; index++) insert.run("sibling", `sibling${index}`, "{}")
            saveCheckpoint(db, resolveBranchHistory(db, "s", "main"), { id: "cp", sessionId: "s", createdAt: 3, reason: "manual",
                throughMessageId: `m${COMPACTED_MESSAGES - 1}`, compactedMessageCount: COMPACTED_MESSAGES, summary: "Full summary" })
        })
        database.read((db) => {
            const descending = plan(db, "SELECT id FROM messages WHERE session_id = ? AND branch_id = ? AND message_order < ? ORDER BY message_order DESC LIMIT ?", ["s", "main", 20_001, 256])
            const suffix = plan(db, "SELECT id FROM messages WHERE session_id = ? AND branch_id = ? AND message_order > ? ORDER BY message_order ASC LIMIT ?", ["s", "main", 18_000, 256])
            const users = plan(db, "SELECT id FROM messages WHERE session_id = ? AND branch_id = ? AND role = ? ORDER BY message_order DESC LIMIT ?", ["s", "main", "user", 256])
            const payloads = plan(db, "SELECT id, payload_json FROM messages WHERE session_id = ? AND id IN (?, ?)", ["s", "m19998", "m19999"])
            expect(descending).toContain("messages_branch_order")
            expect(suffix).toContain("messages_branch_order")
            expect(users).toContain("messages_branch_role_order")
            expect(payloads).toContain("sqlite_autoindex_messages_1")
            for (const detail of [descending, suffix, users, payloads]) {
                expect(detail).not.toContain("SCAN messages")
                expect(detail).not.toContain("TEMP B-TREE")
            }
        })
        const pageTimes: number[] = []
        const contextTimes: number[] = []
        const pageQueryCounts: number[] = []
        const contextQueryCounts: number[] = []
        const query = spyOn(database.connection, "query")
        const latestPage = () => database.read((db) => {
            const history = resolveBranchHistory(db, "s", "main")
            return { ...readHistoryPage(db, history), checkpoint: selectedCheckpoint(db, history) }
        })
        for (let sample = 0; sample < SAMPLE_COUNT; sample++) {
            let started = performance.now()
            query.mockClear()
            const page = latestPage()
            pageTimes.push(performance.now() - started)
            pageQueryCounts.push(query.mock.calls.length)
            expect(query.mock.calls.filter(([sql]) => sql.includes("FROM branches"))).toHaveLength(1)
            expect(page.messages).toHaveLength(500)
            expect(page.messages[0]?.id).toBe("m19500")
            started = performance.now()
            query.mockClear()
            const context = database.read((db) => readRequiredContext(db, resolveBranchHistory(db, "s", "main")))
            contextTimes.push(performance.now() - started)
            contextQueryCounts.push(query.mock.calls.length)
            expect(context.messages).toHaveLength(MAIN_MESSAGES - COMPACTED_MESSAGES)
            expect(context.contextSummary).toBe("Full summary")
        }
        const refreshTimes: number[] = []
        const refreshQueryCounts: number[] = []
        for (let index = 0; index < 20; index++) {
            database.write((db) => appendStoredMessage(db, resolveBranchHistory(db, "s", "main"), {
                id: `committed-${index}`, sessionId: "s", runId: "new", role: "assistant", stopReason: "stop",
                createdAt: 4 + index, content: [{ type: "text", text: "New complete response" }],
            }))
            query.mockClear()
            const started = performance.now()
            const page = latestPage()
            refreshTimes.push(performance.now() - started)
            refreshQueryCounts.push(query.mock.calls.length)
            expect(page.messages).toHaveLength(500)
            expect(page.messages.at(-1)?.id).toBe(`committed-${index}`)
            expect(new Set(page.messages.map((message) => message.id)).size).toBe(500)
        }
        // Count SQL statement requests, not SQLite VM instructions or correlated index probes.
        expect(Math.max(...pageQueryCounts, ...refreshQueryCounts)).toBeLessThan(50)
        query.mockRestore()
        console.info(JSON.stringify({ fixture: "SQLite 20000 main + 2000 sibling, 512-character text", bun: Bun.version,
            sqlite: database.read((db) => db.query("SELECT sqlite_version() AS version").get()),
            latestPageMs: pageTimes.map(round), requiredContextMs: contextTimes.map(round),
            pageQueryCounts, contextQueryCounts, refreshAfterCommitMs: refreshTimes.map(round), refreshQueryCounts }))
    } finally {
        database.close()
        await rm(directory, { recursive: true, force: true })
    }
})

function plan(db: Database, sql: string, bindings: (string | number)[]): string {
    return db.query<{ detail: string }, (string | number)[]>(`EXPLAIN QUERY PLAN ${sql}`).all(...bindings).map((row) => row.detail).join("\n")
}
function round(value: number): number { return Math.round(value * 100) / 100 }
