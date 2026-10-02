import { Database, SQLiteError, type SQLQueryBindings, type Statement } from "bun:sqlite"
import { closeSync, mkdirSync, openSync } from "node:fs"
import { dirname } from "node:path"
import {
    HISTORY_APPLICATION_ID,
    HISTORY_SCHEMA,
    HISTORY_SCHEMA_VERSION,
} from "@/sessions/sqlite/schema"

const BUSY_TIMEOUT_MS = 1_000
const SQLITE_PRIMARY_CODE_MASK = 0xff
const SQLITE_BUSY = 5
const SQLITE_CONSTRAINT = 19
const CONNECTION_FAILURE_CODES = new Set([7, 10, 11, 13, 14, 26])
const EXPECTED_SCHEMA = HISTORY_SCHEMA.split(";").map(normalizeSchemaSql).filter(Boolean).sort()

/** Owns a synchronous connection, never a cache of history payloads. */
export class HistoryDatabase {
    readonly connection: HistoryConnection
    private failure: Error | undefined
    private closed = false

    constructor(readonly path: string) {
        if (path !== ":memory:") createPrivateDatabaseFile(path)
        this.connection = new HistoryConnection(path, { strict: true, safeIntegers: true })
        try {
            this.connection.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
            this.connection.exec("PRAGMA foreign_keys = ON")
            requirePragma(this.connection, "foreign_keys", 1n)
            requirePragma(this.connection, "busy_timeout", BigInt(BUSY_TIMEOUT_MS))
            this.checkIdentity()
            if (path !== ":memory:") {
                this.connection.exec("PRAGMA journal_mode = DELETE")
                requirePragma(this.connection, "journal_mode", "delete")
            }
            this.connection.exec("PRAGMA synchronous = EXTRA")
            requirePragma(this.connection, "synchronous", 3n)
            this.write(() => this.initializeSchema())
        } catch (cause) {
            const failures: unknown[] = [cause]
            try { this.connection.finalizeStatements() } catch (cleanupError) { failures.push(cleanupError) }
            try { this.connection.close(true) } catch (closeError) { failures.push(closeError) }
            if (failures.length > 1) throw new AggregateError(failures, "History initialization and cleanup failed")
            throw cause
        }
    }

    read<T>(operation: (db: Database) => T): T {
        return this.transaction("BEGIN", operation)
    }

    write<T>(operation: (db: Database) => T): T {
        return this.transaction("BEGIN IMMEDIATE", operation)
    }

    assertAvailable(): void {
        if (this.closed) throw new Error("History database is closed")
        if (this.failure) throw new Error("History database is unavailable; reopen the workspace", { cause: this.failure })
    }

    close(): void {
        if (this.closed) return
        this.connection.finalizeStatements()
        this.connection.close(true)
        this.closed = true
    }

    private transaction<T>(begin: string, operation: (db: Database) => T): T {
        this.assertAvailable()
        if (this.connection.inTransaction) throw new Error("Nested history transactions are not allowed")
        let committing = false
        try {
            this.connection.exec(begin)
            const value = operation(this.connection)
            if (value instanceof Promise) throw new Error("History transactions must be synchronous")
            this.connection.finalizeStatements()
            committing = true
            this.connection.exec("COMMIT")
            return value
        } catch (cause) {
            const code = cause instanceof SQLiteError ? cause.errno & SQLITE_PRIMARY_CODE_MASK : undefined
            const failures: unknown[] = [cause]
            try {
                if (this.connection.inTransaction) this.connection.exec("ROLLBACK")
            } catch (rollbackError) { failures.push(rollbackError) }
            try { this.connection.finalizeStatements() } catch (cleanupError) { failures.push(cleanupError) }
            if (failures.length > 1) {
                this.failure = new AggregateError(failures, "History transaction rollback or cleanup failed")
                throw this.failure
            }
            if ((code !== undefined && CONNECTION_FAILURE_CODES.has(code))
                || (committing && code !== SQLITE_BUSY && code !== SQLITE_CONSTRAINT)) {
                this.failure = new Error("History transaction outcome is uncertain", { cause })
            }
            throw cause
        }
    }

    private checkIdentity(): void {
        const version = pragma(this.connection, "user_version")
        const application = pragma(this.connection, "application_id")
        if (version === 0n && application === 0n) {
            const objects = this.connection.query<{ name: string }, []>(
                "SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 1",
            ).get()
            if (objects) throw new Error("Refusing to initialize a nonempty foreign history database")
            return
        }
        if (application !== BigInt(HISTORY_APPLICATION_ID) || version !== BigInt(HISTORY_SCHEMA_VERSION)) {
            throw new Error(`Unsupported history database identity/version: ${String(application)}/${String(version)}`)
        }
    }

    private initializeSchema(): void {
        // A competing process may have initialized the file before BEGIN IMMEDIATE.
        this.checkIdentity()
        if (pragma(this.connection, "user_version") === 0n) {
            this.connection.exec(HISTORY_SCHEMA)
            this.connection.exec(`PRAGMA application_id = ${HISTORY_APPLICATION_ID}`)
            this.connection.exec(`PRAGMA user_version = ${HISTORY_SCHEMA_VERSION}`)
        }
        const definitions = this.connection.query<{ sql: string }, []>(
            "SELECT sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL",
        ).all().map((row) => normalizeSchemaSql(row.sql)).sort()
        if (JSON.stringify(definitions) !== JSON.stringify(EXPECTED_SCHEMA)) {
            throw new Error("Invalid history database schema")
        }
    }
}

/** Transaction-scoped statements cannot retain bound message payloads after a read or write. */
class HistoryConnection extends Database {
    private readonly statements = new Map<string, Statement<unknown, SQLQueryBindings[]>>()

    // Match Bun's conditional parameter type exactly, including its array constraint.
    override query<R, P extends SQLQueryBindings | SQLQueryBindings[]>(sql: string): Statement<R, P extends any[] ? P : [P]> {
        let statement = this.statements.get(sql)
        if (!statement) {
            statement = this.prepare<unknown, SQLQueryBindings[]>(sql)
            this.statements.set(sql, statement)
        }
        return statement as Statement<R, P extends any[] ? P : [P]>
    }

    finalizeStatements(): void {
        const failures: unknown[] = []
        for (const [sql, statement] of this.statements) {
            try {
                statement.finalize()
                this.statements.delete(sql)
            } catch (cause) { failures.push(cause) }
        }
        if (failures.length > 0) throw new AggregateError(failures, "Unable to finalize history statements")
    }
}

export function safeNumber(value: bigint, label: string): number {
    const number = Number(value)
    if (!Number.isSafeInteger(number)) throw new Error(`${label} is outside the safe integer range`)
    return number
}

export function assertSafeInteger(value: number, label: string): void {
    if (!Number.isSafeInteger(value)) throw new Error(`${label} must be a safe integer`)
}

function normalizeSchemaSql(sql: string): string {
    return sql.trim().replace(/\s+/g, " ")
}

function pragma(db: Database, name: string): unknown {
    const row = db.query<Record<string, unknown>, []>(`PRAGMA ${name}`).get()
    return row && Object.values(row)[0]
}

function requirePragma(db: Database, name: string, expected: unknown): void {
    if (pragma(db, name) !== expected) throw new Error(`Unable to configure SQLite ${name}`)
}

function createPrivateDatabaseFile(path: string): void {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    try {
        closeSync(openSync(path, "wx", 0o600))
    } catch (cause) {
        if (!(cause instanceof Error && "code" in cause && cause.code === "EEXIST")) throw cause
    }
}
