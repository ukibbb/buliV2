import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HISTORY_APPLICATION_ID, HISTORY_SCHEMA_V1 } from "@/sessions/sqlite/schema"
import { HistoryDatabase } from "@/sessions/sqlite/database"

test("migrates version 1 atomically without changing existing sessions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "buli-delegation-migration-"))
    const path = join(directory, "history.sqlite")
    try {
        const old = new Database(path)
        old.exec(HISTORY_SCHEMA_V1)
        old.exec(`PRAGMA application_id = ${HISTORY_APPLICATION_ID}; PRAGMA user_version = 1`)
        old.exec("INSERT INTO sessions VALUES ('parent', 'buli', 'Existing', 1, 1, 'main'); INSERT INTO branches VALUES ('parent', 'main', NULL, NULL, NULL)")
        old.close()
        const migrated = new HistoryDatabase(path)
        expect(migrated.connection.query("SELECT title FROM sessions").get()).toEqual({ title: "Existing" })
        expect(migrated.connection.query("PRAGMA user_version").get()).toEqual({ user_version: 2n })
        expect(migrated.connection.query("SELECT count(*) AS count FROM delegated_tasks").get()).toEqual({ count: 0n })
        migrated.close()
        new HistoryDatabase(path).close()
    } finally { await rm(directory, { recursive: true, force: true }) }
})

test("rejects altered version 1 without partially migrating it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "buli-delegation-invalid-"))
    const path = join(directory, "history.sqlite")
    try {
        const old = new Database(path)
        old.exec(HISTORY_SCHEMA_V1)
        old.exec(`PRAGMA application_id = ${HISTORY_APPLICATION_ID}; PRAGMA user_version = 1; DROP INDEX messages_branch_order`)
        old.close()
        expect(() => new HistoryDatabase(path)).toThrow("before migration")
        const inspect = new Database(path)
        expect(inspect.query("PRAGMA user_version").get()).toEqual({ user_version: 1 })
        expect(inspect.query("SELECT name FROM sqlite_schema WHERE name = 'delegated_tasks'").get()).toBeNull()
        inspect.close()
    } finally { await rm(directory, { recursive: true, force: true }) }
})
