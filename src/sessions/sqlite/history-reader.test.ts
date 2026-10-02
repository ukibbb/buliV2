import type { SQLQueryBindings } from "bun:sqlite"
import { expect, spyOn, test } from "bun:test"
import { resolveBranchHistory } from "@/sessions/sqlite/branch-history"
import { HistoryDatabase } from "@/sessions/sqlite/database"
import { messageMetadata, readLastMessageMetadata } from "@/sessions/sqlite/history-reader"

function fixture() {
    const database = new HistoryDatabase(":memory:")
    database.write((db) => {
        db.exec("INSERT INTO sessions VALUES ('s', 'buli', 'History', 1, 1, 'main')")
        db.exec("INSERT INTO branches VALUES ('s', 'main', NULL, NULL, NULL)")
        const insert = db.query(`INSERT INTO messages (session_id, branch_id, id, run_id, created_at, role,
            stop_reason, provider_visible, assistant_message_id, tool_call_id, payload_json)
            VALUES ('s', 'main', ?, 'r', 2, 'assistant', 'stop', 1, NULL, NULL, '{}')`)
        for (let index = 0; index < 300; index++) insert.run(`m${index}`)
        db.exec("INSERT INTO branches VALUES ('s', 'empty-child', 'main', 'm99', NULL)")
        db.exec("INSERT INTO branches VALUES ('s', 'empty-fork', 'main', NULL, NULL)")
    })
    return database
}

for (const [branchId, expectedId, expectedRows] of [
    ["main", "m299", [1]],
    ["empty-child", "m99", [0, 1]],
    ["empty-fork", undefined, [0]],
] as const) {
    test(`tail metadata reads at most one row per visible range (${branchId})`, () => {
        const database = fixture()
        try {
            database.read((db) => {
                const history = resolveBranchHistory(db, "s", branchId)
                const originalQuery = db.query.bind(db)
                const rowCounts: number[] = []
                const limits: unknown[] = []
                const restores: (() => void)[] = []
                const wrapped = new Set<object>()
                const query = spyOn(db, "query").mockImplementation(<R, P extends SQLQueryBindings | SQLQueryBindings[]>(sql: string) => {
                    const statement = originalQuery<R, P>(sql)
                    if (sql.startsWith("SELECT m.message_order") && !wrapped.has(statement)) {
                        wrapped.add(statement)
                        const originalAll = statement.all.bind(statement)
                        const all = spyOn(statement, "all").mockImplementation((...bindings) => {
                            const rows = originalAll(...bindings)
                            limits.push(bindings.at(-1))
                            rowCounts.push(rows.length)
                            return rows
                        })
                        restores.push(() => all.mockRestore())
                    }
                    return statement
                })
                try {
                    expect(readLastMessageMetadata(db, history)?.id).toBe(expectedId)
                    expect(rowCounts).toEqual([...expectedRows])
                    expect(limits.every((limit) => limit === 1)).toBe(true)
                } finally {
                    for (const restore of restores) restore()
                    query.mockRestore()
                }
            })
        } finally { database.close() }
    })
}

test("ordinary metadata scans still return the full history across batch boundaries", () => {
    const database = fixture()
    try {
        database.read((db) => {
            const history = resolveBranchHistory(db, "s", "main")
            const ascending = [...messageMetadata(db, history)]
            expect(ascending).toHaveLength(300)
            expect(ascending[0]?.id).toBe("m0")
            expect(ascending.at(-1)?.id).toBe("m299")
            expect([...messageMetadata(db, history, "DESC")].map((row) => row.id))
                .toEqual(ascending.map((row) => row.id).reverse())
            expect(() => [...messageMetadata(db, history, "ASC", undefined, undefined, undefined, 0)])
                .toThrow("positive safe integer")
        })
    } finally { database.close() }
})
