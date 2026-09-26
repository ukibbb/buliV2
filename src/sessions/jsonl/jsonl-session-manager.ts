import { Buffer } from "node:buffer"
import { createHash, randomUUID } from "node:crypto"
import {
    appendFileSync,
    chmodSync,
    closeSync,
    existsSync,
    fstatSync,
    lstatSync,
    mkdirSync,
    openSync,
    readFileSync,
    readSync,
    realpathSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type {
    IFileChangeProposalRecord,
    TAgentMessage,
} from "@/agent"
import type { ICompactionCheckpoint } from "@/sessions/compaction/checkpoint"
import { InMemorySessionManager } from "@/sessions/in-memory-session-manager"
import { acquireSessionLogLock } from "@/sessions/jsonl/session-log-lock"
import type {
    ISessionInfo,
    ISessionManager,
} from "@/sessions/repository"
import { sessionArchiveRecords } from "@/sessions/jsonl/session-archive-records"
import { assertSessionRecord, SessionRecordType as Kind, serializeSessionRecords, type TSessionRecord } from "@/sessions/jsonl/session-records"
import { replaySessionRecords, SessionReplayError } from "@/sessions/jsonl/session-replay"

interface IJsonlSessionManagerOptions {
    readonly filePath: string
    readonly readOnly?: boolean
}

/** Persists session metadata and direct Agent messages as JSONL records. */
export class JsonlSessionManager implements ISessionManager {
    private readonly memory = new InMemorySessionManager()
    private readonly persistedSessionIds = new Set<string>()
    private readonly filePath: string
    private readonly readOnly: boolean
    private readonly releaseLock: () => void
    private disposed = false

    constructor(options: IJsonlSessionManagerOptions) {
        this.readOnly = options.readOnly ?? false
        // Rewrite the target of a log symlink, not the symlink itself, so our
        // persistence path and its locked sidecar keep the same identity.
        this.filePath = existsSync(options.filePath)
            && lstatSync(options.filePath).isSymbolicLink()
            ? realpathSync(options.filePath)
            : options.filePath
        if (!this.readOnly) {
            mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 })
        }
        this.releaseLock = this.readOnly
            ? () => {}
            : acquireSessionLogLock(this.filePath)
        try {
            this.load()
        } catch (error) {
            // A failed constructor never reaches application disposal.
            this.releaseLock()
            throw error
        }
    }

    readonly createSession = (info: ISessionInfo): void => {
        this.assertWritable()
        this.memory.createSession(info)
    }

    readonly getSessionInfo = (
        sessionId: string,
    ): ISessionInfo | undefined => {
        this.assertActive()
        return this.memory.getSessionInfo(sessionId)
    }

    readonly listSessions = (): readonly ISessionInfo[] => {
        this.assertActive()
        return this.memory.listSessions()
    }

    readonly getMessages = (
        sessionId: string,
    ): readonly TAgentMessage[] => {
        this.assertActive()
        return this.memory.getMessages(sessionId)
    }

    readonly appendMessage = (message: TAgentMessage): void => {
        this.assertWritable()
        this.memory.validateMessageAppend(message)
        this.persistRecord(message.sessionId, {
            recordType: Kind.Message,
            branchId: this.memory.getActiveBranchId(message.sessionId),
            message,
        })
        this.memory.appendMessage(message)
        this.persistedSessionIds.add(message.sessionId)
    }

    // Proposal/checkpoint saves advance the memory token only after persistence
    // succeeds; createSession also allocates a token for its staged, memory-only
    // state. Forward that authority rather than deriving a token from timestamps
    // or rereading JSONL on each streaming publication.
    readonly getPresentationRevision = (sessionId: string): number => {
        this.assertActive()
        return this.memory.getPresentationRevision(sessionId)
    }

    readonly getFileChangeProposals = (
        sessionId: string,
    ): readonly IFileChangeProposalRecord[] => {
        this.assertActive()
        return this.memory.getFileChangeProposals(sessionId)
    }

    readonly getCompactionCheckpoint = (
        sessionId: string,
    ): ICompactionCheckpoint | undefined => {
        this.assertActive()
        return this.memory.getCompactionCheckpoint(sessionId)
    }

    readonly saveCompactionCheckpoint = (checkpoint: ICompactionCheckpoint): void => {
        this.assertWritable()
        this.memory.validateCheckpointSave(checkpoint)
        this.persistRecord(checkpoint.sessionId, {
            recordType: Kind.Compaction,
            branchId: this.memory.getActiveBranchId(checkpoint.sessionId),
            checkpoint,
        })
        this.memory.saveCompactionCheckpoint(checkpoint)
        this.persistedSessionIds.add(checkpoint.sessionId)
    }

    readonly deleteSession = (sessionId: string): void => {
        this.assertWritable()
        if (this.persistedSessionIds.has(sessionId)) {
            const records: TSessionRecord[] = []
            for (const info of this.memory.listSessions()) {
                if (info.id === sessionId || !this.persistedSessionIds.has(info.id)) continue
                records.push(...sessionArchiveRecords(this.memory.getSessionArchive(info.id)))
            }
            this.replaceFile(serializeSessionRecords(records))
        }
        this.memory.deleteSession(sessionId)
        this.persistedSessionIds.delete(sessionId)
    }

    readonly exportSession = (sessionId: string): string => {
        this.assertActive()
        return serializeSessionRecords(sessionArchiveRecords(this.memory.getSessionArchive(sessionId)))
    }

    readonly getActiveBranchId = (sessionId: string): string => {
        this.assertActive()
        return this.memory.getActiveBranchId(sessionId)
    }

    readonly createBranch = (sessionId: string, branchId: string): void => {
        this.assertWritable()
        const branch = this.memory.prepareBranch(sessionId, branchId)
        this.persistRecord(sessionId, { recordType: Kind.Branch, sessionId, branch })
        this.memory.createBranch(sessionId, branchId)
        this.persistedSessionIds.add(sessionId)
    }

    readonly returnToParentBranch = (sessionId: string): void => {
        this.assertWritable()
        const branchId = this.memory.getParentBranchId(sessionId)
        this.persistRecord(sessionId, { recordType: Kind.BranchSelection, sessionId, branchId })
        this.memory.returnToParentBranch(sessionId)
        this.persistedSessionIds.add(sessionId)
    }

    private persistRecord(sessionId: string, record: TSessionRecord): void {
        if (this.persistedSessionIds.has(sessionId)) {
            this.appendRecords([record])
        } else {
            const records: TSessionRecord[] = [
                { recordType: Kind.Session, session: this.memory.getSessionInfo(sessionId)! },
                record,
            ]
            this.replaceFile(this.currentContents() + serializeSessionRecords(records))
        }
    }

    readonly dispose = (): void => {
        if (this.disposed) return
        this.disposed = true
        this.releaseLock()
    }

    private load(): void {
        if (!existsSync(this.filePath)) return
        const contents = readFileSync(this.filePath, "utf8")
        const lines = contents.split("\n")
        const lastRecordIndex = lines.findLastIndex((line) => line.trim().length > 0)
        const records: TSessionRecord[] = []
        const lineIndexes: number[] = []
        let repairedContents: string | undefined
        for (const [index, line] of lines.entries()) {
            if (!line.trim()) continue
            let value: unknown
            try {
                value = JSON.parse(line)
            } catch (error) {
                if (index === lastRecordIndex && !contents.endsWith("\n")) {
                    const completeLines = lines.slice(0, index)
                    repairedContents = completeLines.length > 0 ? `${completeLines.join("\n")}\n` : ""
                    break
                }
                throw this.invalidLineError(index, error)
            }
            try {
                assertSessionRecord(value)
            } catch (error) {
                throw this.invalidLineError(index, error)
            }
            records.push(value)
            lineIndexes.push(index)
        }
        let result
        try {
            result = replaySessionRecords(records)
        } catch (error) {
            if (error instanceof SessionReplayError) {
                throw this.invalidLineError(lineIndexes[error.recordIndex]!, error.cause)
            }
            throw error
        }
        for (const archive of result.archives) {
            this.memory.restoreSessionArchive(archive)
            this.persistedSessionIds.add(archive.info.id)
        }
        if (repairedContents !== undefined && !this.readOnly) this.replaceFile(repairedContents)
        for (const warning of result.warnings) {
            this.warnInvalidCheckpoint(lineIndexes[warning.recordIndex]!, warning.reason)
        }
    }

    private invalidLineError(index: number, cause: unknown): Error {
        return new Error(
            `Invalid session JSONL record on line ${index + 1} in ${this.filePath}: `
            + errorMessage(cause),
            { cause },
        )
    }

    private warnInvalidCheckpoint(index: number, cause: unknown): void {
        console.warn(
            `Ignoring compaction checkpoint on line ${index + 1} in ${this.filePath}: `
            + `${errorMessage(cause)}. Falling back to a valid checkpoint or full history.`,
        )
    }

    private replaceFile(contents: string): void {
        const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`
        const mode = existsSync(this.filePath)
            ? statSync(this.filePath).mode & 0o777
            : 0o600

        try {
            writeFileSync(temporaryPath, contents, {
                encoding: "utf8",
                mode,
            })
            chmodSync(temporaryPath, mode)
            renameSync(temporaryPath, this.filePath)
        } finally {
            rmSync(temporaryPath, { force: true })
        }
    }

    private appendRecords(records: readonly TSessionRecord[]): void {
        /*
         * Steady-state appends need only the final LF byte, not a replay of the
         * growing UTF-8 log. Stat and inspect one byte on the same read-only
         * descriptor; missing/empty files need no separator, and appendFileSync
         * still owns creation. Replay and malformed-tail repair belong to load(),
         * while first-session metadata and its first record still use replaceFile().
         *
         * Always close the probe descriptor, including on stat/read failure.
         * A short read or any probe/close error must stop before appending rather
         * than guess a separator. The append remains synchronous: callers update
         * memory and acknowledge message_end only after persistence succeeds.
         * The lifetime sidecar lock excludes other managers; this is not an fsync.
         */
        let separator = ""
        if (existsSync(this.filePath)) {
            const descriptor = openSync(this.filePath, "r")
            try {
                const { size } = fstatSync(descriptor)
                if (size > 0) {
                    const lastByte = Buffer.alloc(1)
                    if (readSync(descriptor, lastByte, 0, 1, size - 1) !== 1) {
                        throw new Error("Unable to read the final byte of the session log")
                    }
                    if (lastByte[0] !== 0x0a) separator = "\n"
                }
            } finally {
                closeSync(descriptor)
            }
        }
        appendFileSync(
            this.filePath,
            `${separator}${serializeSessionRecords(records)}`,
            { encoding: "utf8", mode: 0o600 },
        )
    }

    private currentContents(): string {
        if (!existsSync(this.filePath)) return ""
        const contents = readFileSync(this.filePath, "utf8")
        return contents.length === 0 || contents.endsWith("\n")
            ? contents
            : `${contents}\n`
    }

    private assertWritable(): void {
        this.assertActive()
        if (this.readOnly) throw new Error("Session log is read-only")
    }

    private assertActive(): void {
        if (this.disposed) throw new Error("JSONL session manager is disposed")
    }
}

/** Resolves the stable per-workspace path for the global session log. */
export function defaultSessionFilePath(
    workspaceRoot = process.cwd(),
): string {
    const canonicalWorkspace = realpathSync(workspaceRoot)
    const workspaceID = createHash("sha256")
        .update(canonicalWorkspace)
        .digest("hex")
    return join(homedir(), ".buli", "sessions", `${workspaceID}.jsonl`)
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

