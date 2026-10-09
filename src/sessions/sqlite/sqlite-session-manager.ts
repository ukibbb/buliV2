import type { IDelegatedTask } from "@/sessions/delegated-task"
import type { Database } from "bun:sqlite"
import type { IUserPathReference } from "@/agent"
import { dirname, join } from "node:path"
import type { ICompactionCheckpoint } from "@/sessions/compaction/checkpoint"
import type { IHistoryCursor, IHistoryPage, IRequiredContext, TAppendMessageResult, TStoredMessage } from "@/sessions/history-contracts"
import type { ISessionInfo, ISessionManager } from "@/sessions/repository"
import { acquireSessionLock } from "@/sessions/session-lock"
import { resolveBranchHistory, type IResolvedBranchHistory } from "@/sessions/sqlite/branch-history"
import { readRequiredContext, saveCheckpoint, selectedCheckpoint } from "@/sessions/sqlite/checkpoint-repository"
import { assertSafeInteger, HistoryDatabase, safeNumber } from "@/sessions/sqlite/database"
import { readLastMessageMetadata, readHistoryPage, validateHistory } from "@/sessions/sqlite/history-reader"
import { appendStoredMessage } from "@/sessions/sqlite/message-repository"
import { recoverInterruptedTools } from "@/sessions/sqlite/recovery-repository"
import { readRecentConversation, readSelectedPaths } from "@/sessions/sqlite/tool-history-repository"
import { assertSessionInfo } from "@/sessions/validation"

interface ISessionRow {
    readonly id: string
    readonly agent_id: string
    readonly title: string
    readonly created_at: bigint
    readonly updated_at: bigint
}

/** SQLite-only durable history. Ownership is session-scoped; the connection is workspace-scoped. */
export class SQLiteSessionManager implements ISessionManager {
    private readonly database: HistoryDatabase
    private readonly owners = new Map<string, () => void>()
    private readonly directory: string | undefined

    constructor(options: { readonly directoryPath: string } | { readonly databasePath: string }) {
        const path = "databasePath" in options ? options.databasePath : join(options.directoryPath, "sessions.sqlite")
        this.database = new HistoryDatabase(path)
        this.directory = path === ":memory:" ? undefined : dirname(path)
    }

    readonly createSession = (info: ISessionInfo): void => {
        assertSessionInfo(info)
        assertSafeInteger(info.createdAt, "createdAt")
        assertSafeInteger(info.updatedAt, "updatedAt")
        if (this.owners.has(info.id)) throw new Error(`Session already open: ${info.id}`)
        this.acquire(info.id)
        try {
            this.database.write((db) => {
                db.query("INSERT INTO sessions (id, agent_id, title, created_at, updated_at, active_branch_id) VALUES (?, ?, ?, ?, ?, 'main')")
                    .run(info.id, info.agentId, info.title, info.createdAt, info.updatedAt)
                db.query("INSERT INTO branches (session_id, id) VALUES (?, 'main')").run(info.id)
            })
        } catch (cause) {
            this.releaseSession(info.id)
            throw cause
        }
    }

    readonly createDelegatedTask = (info: ISessionInfo, task: IDelegatedTask): void => {
        this.requireOwner(task.parentSessionId)
        assertSessionInfo(info)
        if (info.id !== task.childSessionId || task.status !== "running") throw new Error("Invalid delegated task")
        this.acquire(info.id)
        try {
            this.database.write((db) => {
                db.query("INSERT INTO sessions (id, agent_id, title, created_at, updated_at, active_branch_id) VALUES (?, ?, ?, ?, ?, 'main')")
                    .run(info.id, info.agentId, info.title, info.createdAt, info.updatedAt)
                db.query("INSERT INTO branches (session_id, id) VALUES (?, 'main')").run(info.id)
                db.query("INSERT INTO delegated_tasks VALUES (?, ?, ?, ?, ?, ?, ?)")
                    .run(task.id, task.parentSessionId, task.assistantMessageId, task.toolCallId, task.childSessionId, task.position, JSON.stringify(task))
            })
        } catch (error) {
            this.releaseSession(info.id)
            throw error
        }
    }

    readonly updateDelegatedTask = (task: IDelegatedTask): void => {
        this.requireOwner(task.parentSessionId)
        this.database.write((db) => {
            const result = db.query("UPDATE delegated_tasks SET payload_json = ? WHERE id = ? AND parent_session_id = ? AND child_session_id = ?")
                .run(JSON.stringify(task), task.id, task.parentSessionId, task.childSessionId)
            if (result.changes !== 1) throw new Error("Delegated task does not exist")
        })
    }

    readonly loadDelegatedTasks = (parentSessionId: string, assistantMessageId: string, toolCallId: string): readonly IDelegatedTask[] => {
        this.requireOwner(parentSessionId)
        return this.database.read((db) => db.query<{ payload_json: string }, [string, string, string]>(
            "SELECT payload_json FROM delegated_tasks WHERE parent_session_id = ? AND assistant_message_id = ? AND tool_call_id = ? ORDER BY position",
        ).all(parentSessionId, assistantMessageId, toolCallId).map((row) => JSON.parse(row.payload_json) as IDelegatedTask))
    }

    readonly updateSessionAgent = (sessionId: string, agentId: string): void => {
        this.requireOwner(sessionId)
        if (!agentId.trim()) throw new Error("Agent ID cannot be empty")
        this.database.write((db) => {
            const result = db.query("UPDATE sessions SET agent_id = ? WHERE id = ?").run(agentId, sessionId)
            if (result.changes !== 1) throw new Error(`Session does not exist: ${sessionId}`)
        })
    }

    readonly openSession = (sessionId: string): void => {
        this.database.assertAvailable()
        if (this.owners.has(sessionId)) return
        this.acquire(sessionId)
        try {
            this.database.read((db) => validateHistory(db, this.activeHistory(db, sessionId)))
        } catch (cause) {
            this.releaseSession(sessionId)
            throw cause
        }
    }

    readonly releaseSession = (sessionId: string): void => {
        const release = this.owners.get(sessionId)
        if (!release) return
        release()
        this.owners.delete(sessionId)
    }

    readonly listSessions = (): readonly ISessionInfo[] => this.database.read((db) => db.query<ISessionRow, []>(
        "SELECT id, agent_id, title, created_at, updated_at FROM sessions WHERE NOT EXISTS (SELECT 1 FROM delegated_tasks WHERE child_session_id = sessions.id) ORDER BY updated_at DESC, created_at DESC, id",
    ).all().map(sessionInfo))

    readonly getSessionInfo = (sessionId: string): ISessionInfo | undefined => this.database.read((db) => {
        const row = db.query<ISessionRow, [string]>(
            "SELECT id, agent_id, title, created_at, updated_at FROM sessions WHERE id = ?",
        ).get(sessionId)
        return row ? sessionInfo(row) : undefined
    })

    readonly getActiveBranchId = (sessionId: string): string => {
        this.requireOwner(sessionId)
        return this.database.read((db) => this.activeBranchId(db, sessionId))
    }

    readonly appendMessage = (message: TStoredMessage): TAppendMessageResult => {
        this.requireOwner(message.sessionId)
        return this.database.write((db) => appendStoredMessage(db, this.activeHistory(db, message.sessionId), message))
    }

    readonly recoverInterruptedTools = (sessionId: string): void => {
        this.requireOwner(sessionId)
        this.database.write((db) => {
            recoverInterruptedTools(db, this.activeHistory(db, sessionId))
            const rows = db.query<{ id: string; payload_json: string }, [string]>(
                "SELECT id, payload_json FROM delegated_tasks WHERE parent_session_id = ?",
            ).all(sessionId)
            for (const row of rows) {
                const task = JSON.parse(row.payload_json) as IDelegatedTask
                if (task.status === "running") db.query("UPDATE delegated_tasks SET payload_json = ? WHERE id = ?")
                    .run(JSON.stringify({ ...task, status: "interrupted", finishedAt: Date.now(), error: "Application stopped before task completion" }), row.id)
            }
        })
    }

    readonly loadRequiredContext = (sessionId: string): IRequiredContext => {
        this.requireOwner(sessionId)
        return this.database.read((db) => readRequiredContext(db, this.activeHistory(db, sessionId)))
    }

    readonly loadRecentConversation = (sessionId: string): readonly TStoredMessage[] => {
        this.requireOwner(sessionId)
        return this.database.read((db) => readRecentConversation(db, this.activeHistory(db, sessionId)))
    }

    readonly loadSelectedPaths = (sessionId: string): readonly IUserPathReference[] => {
        this.requireOwner(sessionId)
        return this.database.read((db) => readSelectedPaths(db, this.activeHistory(db, sessionId)))
    }

    readonly loadHistoryPage = (sessionId: string, branchId: string, cursor?: IHistoryCursor): IHistoryPage => {
        this.requireOwner(sessionId)
        return this.database.read((db) => {
            const history = resolveBranchHistory(db, sessionId, branchId)
            const page = readHistoryPage(db, history, cursor)
            const checkpoint = selectedCheckpoint(db, history)
            return { ...page, ...(checkpoint ? { checkpoint } : {}) }
        })
    }

    readonly getCompactionCheckpoint = (sessionId: string): ICompactionCheckpoint | undefined => {
        this.requireOwner(sessionId)
        return this.database.read((db) => selectedCheckpoint(db, this.activeHistory(db, sessionId)))
    }

    readonly saveCompactionCheckpoint = (checkpoint: ICompactionCheckpoint): void => {
        this.requireOwner(checkpoint.sessionId)
        this.database.write((db) => saveCheckpoint(db, this.activeHistory(db, checkpoint.sessionId), checkpoint))
    }

    readonly createBranch = (sessionId: string, branchId: string): void => {
        this.requireOwner(sessionId)
        if (!branchId.trim() || branchId === "main") throw new Error("Invalid new branch ID")
        this.database.write((db) => {
            const history = this.activeHistory(db, sessionId)
            const validation = validateHistory(db, history)
            if (validation.pendingAssistantId) throw new Error("Cannot fork an unfinished tool group")
            const anchor = readLastMessageMetadata(db, history)?.id ?? null
            const checkpoint = selectedCheckpoint(db, history)
            db.query(`INSERT INTO branches (session_id, id, parent_branch_id, fork_message_id, inherited_checkpoint_id)
                VALUES (?, ?, ?, ?, ?)`)
                .run(sessionId, branchId, history.branchId, anchor, checkpoint?.id ?? null)
            db.query("UPDATE sessions SET active_branch_id = ? WHERE id = ?").run(branchId, sessionId)
        })
    }

    readonly returnToParentBranch = (sessionId: string): void => {
        this.requireOwner(sessionId)
        this.database.write((db) => {
            const history = this.activeHistory(db, sessionId)
            const parent = history.chain.at(-1)?.parent_branch_id
            if (!parent) throw new Error("The main branch has no return destination")
            db.query("UPDATE sessions SET active_branch_id = ? WHERE id = ?").run(parent, sessionId)
        })
    }

    readonly deleteEmptySession = (sessionId: string): boolean => {
        this.requireOwner(sessionId)
        return this.database.write((db) => {
            this.activeBranchId(db, sessionId)
            const content = db.query<{ present: bigint }, [string, string]>(`
                SELECT EXISTS(SELECT 1 FROM messages WHERE session_id = ?)
                    OR EXISTS(SELECT 1 FROM checkpoints WHERE session_id = ?) AS present
            `).get(sessionId, sessionId)
            if (content?.present !== 0n) return false
            db.query("DELETE FROM branches WHERE session_id = ?").run(sessionId)
            db.query("DELETE FROM sessions WHERE id = ?").run(sessionId)
            return true
        })
    }

    readonly deleteSession = (sessionId: string): void => {
        this.requireOwner(sessionId)
        const children = this.database.read((db) => db.query<{ child_session_id: string }, [string]>(
            "SELECT child_session_id FROM delegated_tasks WHERE parent_session_id = ?",
        ).all(sessionId).map((row) => row.child_session_id))
        for (const child of children) this.openSession(child)
        this.database.write((db) => {
            db.query("DELETE FROM delegated_tasks WHERE parent_session_id = ?").run(sessionId)
            for (const child of children) {
                for (const table of ["tool_calls", "checkpoints", "messages", "branches"]) {
                    db.query(`DELETE FROM ${table} WHERE session_id = ?`).run(child)
                }
                db.query("DELETE FROM sessions WHERE id = ?").run(child)
            }
            // All cross-table constraints are deferred; ownership stays held until safe release.
            for (const table of ["tool_calls", "checkpoints", "messages", "branches"]) {
                db.query(`DELETE FROM ${table} WHERE session_id = ?`).run(sessionId)
            }
            db.query("DELETE FROM sessions WHERE id = ?").run(sessionId)
        })
        for (const child of children) this.releaseSession(child)
    }

    readonly dispose = (): void => {
        this.database.close()
        const failures: unknown[] = []
        for (const id of this.owners.keys()) {
            try { this.releaseSession(id) } catch (cause) { failures.push(cause) }
        }
        if (failures.length > 0) throw new AggregateError(failures, "Unable to release history ownership")
    }

    private activeBranchId(db: Database, sessionId: string): string {
        const row = db.query<{ active_branch_id: string }, [string]>(
            "SELECT active_branch_id FROM sessions WHERE id = ?",
        ).get(sessionId)
        if (!row) throw new Error(`Session does not exist: ${sessionId}`)
        return row.active_branch_id
    }

    private activeHistory(db: Database, sessionId: string): IResolvedBranchHistory {
        return resolveBranchHistory(db, sessionId, this.activeBranchId(db, sessionId))
    }

    private acquire(sessionId: string): void {
        this.database.assertAvailable()
        const release = this.directory === undefined ? () => {} : acquireSessionLock(this.directory, sessionId)
        this.owners.set(sessionId, release)
    }

    private requireOwner(sessionId: string): void {
        this.database.assertAvailable()
        if (!this.owners.has(sessionId)) throw new Error(`Session is not open: ${sessionId}`)
    }
}

function sessionInfo(row: ISessionRow): ISessionInfo {
    const info = { id: row.id, agentId: row.agent_id, title: row.title,
        createdAt: safeNumber(row.created_at, "createdAt"), updatedAt: safeNumber(row.updated_at, "updatedAt") }
    assertSessionInfo(info)
    return info
}
