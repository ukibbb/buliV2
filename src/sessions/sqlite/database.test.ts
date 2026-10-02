import { Database } from "bun:sqlite"
import { describe, expect, spyOn, test } from "bun:test"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HistoryDatabase, safeNumber } from "@/sessions/sqlite/database"
import { HISTORY_APPLICATION_ID, HISTORY_SCHEMA_VERSION } from "@/sessions/sqlite/schema"

function createSession(db: Database, id = "s"): void {
    db.query("INSERT INTO sessions VALUES (?, 'buli', 'Title', 1, 1, 'main')").run(id)
    db.query("INSERT INTO branches VALUES (?, 'main', NULL, NULL, NULL)").run(id)
}

describe("SQLite history connection", () => {
    test("initializes an empty strict, foreign-key checked schema", () => {
        const history = new HistoryDatabase(":memory:")
        try {
            expect(history.read((db) => db.query("PRAGMA foreign_keys").get())).toEqual({ foreign_keys: 1n })
            expect(history.read((db) => db.query("PRAGMA synchronous").get())).toEqual({ synchronous: 3n })
            expect(history.read((db) => db.query("PRAGMA application_id").get())).toEqual({ application_id: BigInt(HISTORY_APPLICATION_ID) })
            expect(history.read((db) => db.query("PRAGMA user_version").get())).toEqual({ user_version: BigInt(HISTORY_SCHEMA_VERSION) })
            history.write((db) => createSession(db))
            expect(history.read((db) => db.query("SELECT id FROM sessions").all())).toEqual([{ id: "s" }])
            expect(history.read((db) => db.query("PRAGMA foreign_key_check").all())).toEqual([])
        } finally { history.close() }
    })

    test("rolls back a callback failure and a deferred foreign key failure", () => {
        const history = new HistoryDatabase(":memory:")
        try {
            expect(() => history.write((db) => {
                createSession(db)
                throw new Error("after writes")
            })).toThrow("after writes")
            expect(() => history.write((db) => {
                db.exec("INSERT INTO sessions VALUES ('s', 'buli', 'Title', 1, 1, 'main')")
            })).toThrow()
            expect(history.connection.inTransaction).toBe(false)
            expect(history.read((db) => db.query("SELECT * FROM sessions").all())).toEqual([])
            history.write((db) => createSession(db))
        } finally { history.close() }
    })

    test("rejects asynchronous and nested transaction callbacks", () => {
        const history = new HistoryDatabase(":memory:")
        try {
            expect(() => history.write(() => Promise.resolve())).toThrow("synchronous")
            expect(() => history.read(() => history.read(() => 1))).toThrow("Nested")
            expect(history.connection.inTransaction).toBe(false)
        } finally { history.close() }
    })

    test("creates a private file, reopens committed data and keeps rollback journal", async () => {
        const directory = await mkdtemp(join(tmpdir(), "buli-sqlite-"))
        const path = join(directory, "sessions.sqlite")
        let history: HistoryDatabase | undefined
        try {
            history = new HistoryDatabase(path)
            history.write((db) => createSession(db))
            expect(history.read((db) => db.query("PRAGMA journal_mode").get())).toEqual({ journal_mode: "delete" })
            if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600)
            history.close()
            history = new HistoryDatabase(path)
            expect(history.read((db) => db.query("SELECT id FROM sessions").all())).toEqual([{ id: "s" }])
            history.close()
            history.close()
            expect(() => history!.read(() => 1)).toThrow("closed")
        } finally {
            history?.close()
            await rm(directory, { recursive: true, force: true })
        }
    })

    test("refuses a foreign database without rewriting its contents", async () => {
        const directory = await mkdtemp(join(tmpdir(), "buli-sqlite-foreign-"))
        const path = join(directory, "sessions.sqlite")
        try {
            const foreign = new Database(path)
            foreign.exec("CREATE TABLE foreign_data (value TEXT); INSERT INTO foreign_data VALUES ('keep')")
            foreign.close()
            expect(() => new HistoryDatabase(path)).toThrow("foreign")
            const check = new Database(path)
            try { expect(check.query("SELECT * FROM foreign_data").all()).toEqual([{ value: "keep" }]) }
            finally { check.close() }
        } finally { await rm(directory, { recursive: true, force: true }) }
    })

    test("finalizes more than Bun's query-cache capacity before strict close", () => {
        const history = new HistoryDatabase(":memory:")
        history.read((db) => {
            for (let index = 0; index < 300; index++) db.query(`SELECT ${index}`).get()
        })
        expect(() => history.close()).not.toThrow()
    })

    test("blocks subsequent access when COMMIT succeeded but its outcome was not reported", () => {
        const history = new HistoryDatabase(":memory:")
        const exec = history.connection.exec.bind(history.connection)
        const spy = spyOn(history.connection, "exec").mockImplementation((sql, ...parameters) => {
            const result = exec(sql, ...parameters)
            if (sql === "COMMIT") throw new Error("lost commit acknowledgement")
            return result
        })
        try {
            expect(() => history.write((db) => createSession(db))).toThrow("lost commit acknowledgement")
            spy.mockRestore()
            expect(history.connection.inTransaction).toBe(false)
            expect(history.connection.query("SELECT id FROM sessions").all()).toEqual([{ id: "s" }])
            expect(() => history.read(() => 1)).toThrow("unavailable")
            expect(() => history.write(() => 1)).toThrow("unavailable")
        } finally { spy.mockRestore(); history.close() }
    })

    test("retains both the original error and a failed rollback, then poisons the connection", () => {
        const history = new HistoryDatabase(":memory:")
        const exec = history.connection.exec.bind(history.connection)
        const spy = spyOn(history.connection, "exec").mockImplementation((sql, ...parameters) => {
            if (sql === "ROLLBACK") throw new Error("rollback fault")
            return exec(sql, ...parameters)
        })
        try {
            let failure: unknown
            try { history.write(() => { throw new Error("original fault") }) } catch (cause) { failure = cause }
            expect(failure).toBeInstanceOf(AggregateError)
            expect((failure as AggregateError).errors.map((error: Error) => error.message)).toEqual(["original fault", "rollback fault"])
            expect(() => history.read(() => 1)).toThrow("unavailable")
        } finally {
            spy.mockRestore()
            if (history.connection.inTransaction) history.connection.exec("ROLLBACK")
            history.close()
        }
    })

    test("rolls back commit contention without poisoning a known unchanged transaction", async () => {
        const directory = await mkdtemp(join(tmpdir(), "buli-sqlite-busy-"))
        const path = join(directory, "sessions.sqlite")
        const history = new HistoryDatabase(path)
        const reader = new Database(path)
        try {
            history.connection.exec("PRAGMA busy_timeout = 1")
            reader.exec("BEGIN")
            reader.query("SELECT * FROM sessions").all()
            expect(() => history.write((db) => createSession(db))).toThrow()
            expect(history.connection.inTransaction).toBe(false)
            reader.exec("ROLLBACK")
            expect(history.read((db) => db.query("SELECT id FROM sessions").all())).toEqual([])
            history.write((db) => createSession(db))
        } finally {
            reader.close(); history.close()
            await rm(directory, { recursive: true, force: true })
        }
    })

    test("rejects unsupported identity, missing indexes, and extra triggers on reopen", async () => {
        const directory = await mkdtemp(join(tmpdir(), "buli-sqlite-schema-"))
        try {
            for (const [index, alteration] of [
                "PRAGMA user_version = 2",
                "PRAGMA application_id = 123",
                "DROP INDEX messages_branch_order",
                "CREATE TRIGGER unexpected AFTER INSERT ON messages BEGIN SELECT 1; END",
            ].entries()) {
                const path = join(directory, `${index}.sqlite`)
                new HistoryDatabase(path).close()
                const tamper = new Database(path)
                try { tamper.exec(alteration) } finally { tamper.close() }
                expect(() => new HistoryDatabase(path)).toThrow()
            }
        } finally { await rm(directory, { recursive: true, force: true }) }
    })

    test("never silently rounds a 64-bit order or count", () => {
        expect(safeNumber(12n, "count")).toBe(12)
        expect(() => safeNumber(9_007_199_254_740_993n, "count")).toThrow("safe integer")
    })
})
