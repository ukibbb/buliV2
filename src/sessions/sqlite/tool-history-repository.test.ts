import type { SQLQueryBindings } from "bun:sqlite"
import { expect, spyOn, test } from "bun:test"
import type { IAssistantMessage, IUserMessage } from "@/agent"
import { resolveBranchHistory } from "@/sessions/sqlite/branch-history"
import { HistoryDatabase } from "@/sessions/sqlite/database"
import { readRecentConversation } from "@/sessions/sqlite/tool-history-repository"

const base = { sessionId: "s", runId: "r", createdAt: 2 }
const betweenIds = Array.from({ length: 270 }, (_, index) => `a298-${index}`)

function fixture(): HistoryDatabase {
    const database = new HistoryDatabase(":memory:")
    database.write((db) => {
        db.exec("INSERT INTO sessions VALUES ('s', 'buli', 'History', 1, 1, 'main')")
        db.exec("INSERT INTO branches VALUES ('s', 'main', NULL, NULL, NULL)")
        const insert = db.query(`INSERT INTO messages (session_id, branch_id, id, run_id, created_at, role,
            stop_reason, provider_visible, assistant_message_id, tool_call_id, payload_json)
            VALUES ('s', ?, ?, 'r', 2, ?, ?, ?, NULL, NULL, ?)`)
        function user(id: string, branch = "main"): void {
            const message: IUserMessage = { ...base, id, role: "user", source: "prompt", content: id }
            insert.run(branch, id, message.role, null, 0, JSON.stringify(message))
        }
        function assistant(id: string, branch = "main"): void {
            const message: IAssistantMessage = { ...base, id, role: "assistant", stopReason: "stop", content: [{ type: "text", text: id }] }
            insert.run(branch, id, message.role, message.stopReason, 1, JSON.stringify(message))
        }
        for (let index = 0; index < 300; index++) {
            user(`u${index}`)
            for (const id of index === 298 ? betweenIds : [`a${index}-0`]) assistant(id)
        }
        db.exec("INSERT INTO branches VALUES ('s', 'empty-child', 'main', 'a299-0', NULL)")
        db.exec("INSERT INTO branches VALUES ('s', 'side', 'main', 'a298-269', NULL)")
        user("side-current", "side")
        assistant("after-side-current", "side")
        db.exec("INSERT INTO branches VALUES ('s', 'sibling', 'main', 'a298-269', NULL)")
        user("sibling-current", "sibling")
        assistant("after-sibling-current", "sibling")
        db.exec("INSERT INTO branches VALUES ('s', 'empty-fork', 'main', NULL, NULL)")
        db.exec("INSERT INTO branches VALUES ('s', 'single-user', 'main', NULL, NULL)")
        user("only-user", "single-user")
        assistant("after-only-user", "single-user")
        db.exec("INSERT INTO branches VALUES ('s', 'no-users', 'main', NULL, NULL)")
        assistant("only-assistant", "no-users")
    })
    return database
}

for (const [branchId, expectedIds, expectedUserRows] of [
    ["main", ["u298", ...betweenIds, "u299"], [2]],
    ["empty-child", ["u298", ...betweenIds, "u299"], [0, 2]],
    ["side", ["u298", ...betweenIds, "side-current"], [1, 2]],
    ["empty-fork", [], [0]],
    ["single-user", ["only-user"], [1]],
    ["no-users", [], [0]],
] as const) {
    test(`recent conversation reads users in batches of two without limiting assistants (${branchId})`, () => {
        const database = fixture()
        try {
            database.read((db) => {
                const history = resolveBranchHistory(db, "s", branchId)
                const originalQuery = db.query.bind(db)
                const userRows: number[] = []
                const userLimits: unknown[] = []
                const assistantLimits: unknown[] = []
                const restores: (() => void)[] = []
                const wrapped = new Set<object>()
                const query = spyOn(db, "query").mockImplementation(<R, P extends SQLQueryBindings | SQLQueryBindings[]>(sql: string) => {
                    const statement = originalQuery<R, P>(sql)
                    if (sql.startsWith("SELECT m.message_order") && !wrapped.has(statement)) {
                        wrapped.add(statement)
                        const originalAll = statement.all.bind(statement)
                        const all = spyOn(statement, "all").mockImplementation((...bindings) => {
                            const rows = originalAll(...bindings)
                            const values: readonly unknown[] = bindings
                            if (values.includes("user")) {
                                userRows.push(rows.length)
                                userLimits.push(bindings.at(-1))
                            } else if (values.includes("assistant")) {
                                assistantLimits.push(bindings.at(-1))
                            }
                            return rows
                        })
                        restores.push(() => all.mockRestore())
                    }
                    return statement
                })
                try {
                    expect(readRecentConversation(db, history).map((message) => message.id)).toEqual([...expectedIds])
                    expect(userRows).toEqual([...expectedUserRows])
                    expect(userLimits).toEqual(expectedUserRows.map(() => 2))
                    if (expectedIds.length > 2) {
                        expect(assistantLimits.length).toBeGreaterThanOrEqual(2)
                        expect(assistantLimits.every((limit) => limit === 256)).toBe(true)
                    } else {
                        expect(assistantLimits).toEqual([])
                    }
                } finally {
                    for (const restore of restores) restore()
                    query.mockRestore()
                }
            })
        } finally { database.close() }
    })
}
