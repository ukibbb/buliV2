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
import {
    assertCheckpointAnchor,
    type ICompactionCheckpoint,
} from "@/sessions/compaction/checkpoint"
import { InMemorySessionManager } from "@/sessions/in-memory-session-manager"
import { acquireSessionLogLock } from "@/sessions/jsonl/session-log-lock"
import type {
    ISessionInfo,
    ISessionManager,
} from "@/sessions/repository"
import {
    assertCompactionCheckpoint,
    assertDurableSessionMessage,
    assertFileChangeProposalRecord,
    assertSessionInfo,
} from "@/sessions/validation"

interface IJsonlSessionManagerOptions {
    readonly filePath: string
}

interface ISessionRecord {
    readonly recordType: "session"
    readonly version: 2
    readonly session: ISessionInfo
}

interface IMessageRecord {
    readonly recordType: "message"
    readonly version: 2
    readonly message: TAgentMessage
}

interface ICompactionRecord {
    readonly recordType: "compaction"
    readonly version: 2
    readonly checkpoint: ICompactionCheckpoint
}

interface IFileChangeProposalJsonlRecord {
    readonly recordType: "fileChangeProposal"
    readonly version: 2
    readonly proposal: IFileChangeProposalRecord
}

/** Persists session metadata and direct Agent messages as JSONL records. */
export class JsonlSessionManager implements ISessionManager {
    private readonly memory = new InMemorySessionManager()
    private readonly persistedSessionIds = new Set<string>()
    private readonly filePath: string
    private readonly releaseLock: () => void
    private disposed = false

    constructor(options: IJsonlSessionManagerOptions) {
        // Rewrite the target of a log symlink, not the symlink itself, so our
        // persistence path and its locked sidecar keep the same identity.
        this.filePath = existsSync(options.filePath)
            && lstatSync(options.filePath).isSymbolicLink()
            ? realpathSync(options.filePath)
            : options.filePath
        mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 })
        this.releaseLock = acquireSessionLogLock(this.filePath)
        try {
            this.load()
        } catch (error) {
            // A failed constructor never reaches application disposal.
            this.releaseLock()
            throw error
        }
    }

    readonly createSession = (info: ISessionInfo): void => {
        this.assertActive()
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
        this.assertActive()
        assertDurableSessionMessage(message)

        const info = this.memory.getSessionInfo(message.sessionId)
        if (!info) {
            throw new Error(`Session does not exist: ${message.sessionId}`)
        }

        const isPersisted = this.persistedSessionIds.has(message.sessionId)
        const records: readonly unknown[] = isPersisted
            ? [messageRecord(message)]
            : [sessionRecord(info), messageRecord(message)]

        if (isPersisted) this.appendRecords(records)
        else this.replaceFile(this.currentContents() + serializeRecords(records))
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

    readonly saveFileChangeProposal = (
        proposal: IFileChangeProposalRecord,
    ): void => {
        this.assertActive()
        assertFileChangeProposalRecord(proposal)

        const info = this.memory.getSessionInfo(proposal.sessionId)
        if (!info) {
            throw new Error(`Session does not exist: ${proposal.sessionId}`)
        }

        const isPersisted = this.persistedSessionIds.has(proposal.sessionId)
        const records: readonly unknown[] = isPersisted
            ? [fileChangeProposalRecord(proposal)]
            : [sessionRecord(info), fileChangeProposalRecord(proposal)]

        if (isPersisted) this.appendRecords(records)
        else this.replaceFile(this.currentContents() + serializeRecords(records))
        this.memory.saveFileChangeProposal(proposal)
        this.persistedSessionIds.add(proposal.sessionId)
    }

    readonly getCompactionCheckpoint = (
        sessionId: string,
    ): ICompactionCheckpoint | undefined => {
        this.assertActive()
        return this.memory.getCompactionCheckpoint(sessionId)
    }

    readonly saveCompactionCheckpoint = (
        checkpoint: ICompactionCheckpoint,
    ): void => {
        this.assertActive()
        assertCompactionCheckpoint(checkpoint)
        assertCheckpointAnchor(
            checkpoint,
            this.memory.getMessages(checkpoint.sessionId),
        )
        // Checkpoint jest append-only jak wiadomości. Powtórne kompaktowanie dopisuje
        // nowszy rekord, a load wybiera ostatni.
        this.appendRecords([compactionRecord(checkpoint)])
        this.memory.saveCompactionCheckpoint(checkpoint)
        this.persistedSessionIds.add(checkpoint.sessionId)
    }

    readonly deleteSession = (sessionId: string): void => {
        this.assertActive()
        const wasPersisted = this.persistedSessionIds.has(sessionId)
        if (wasPersisted) {
            const records: unknown[] = []
            for (const info of this.memory.listSessions()) {
                if (info.id === sessionId || !this.persistedSessionIds.has(info.id)) {
                    continue
                }
                records.push(sessionRecord(info))
                records.push(
                    ...this.memory.getMessages(info.id).map(messageRecord),
                )
                records.push(
                    ...this.memory.getFileChangeProposals(info.id)
                        .map(fileChangeProposalRecord),
                )
                const checkpoint = this.memory.getCompactionCheckpoint(info.id)
                if (checkpoint) records.push(compactionRecord(checkpoint))
            }
            this.replaceFile(serializeRecords(records))
        }
        this.memory.deleteSession(sessionId)
        this.persistedSessionIds.delete(sessionId)
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
        const hasTerminatedTail = contents.endsWith("\n")
        const lastRecordIndex = lines.findLastIndex((line) => line.trim().length > 0)
        const infoBySession = new Map<string, ISessionInfo>()
        const messagesBySession = new Map<string, TAgentMessage[]>()
        const proposalsBySession = new Map<
            string,
            IFileChangeProposalRecord[]
        >()
        const checkpointsBySession = new Map<string, {
            readonly index: number
            readonly checkpoint: ICompactionCheckpoint
        }[]>()
        const sessionOrder: string[] = []
        const seenSessionIds = new Set<string>()

        const rememberSession = (sessionId: string): void => {
            if (seenSessionIds.has(sessionId)) return
            seenSessionIds.add(sessionId)
            sessionOrder.push(sessionId)
        }

        for (const [index, line] of lines.entries()) {
            if (!line.trim()) continue

            let value: unknown
            try {
                value = JSON.parse(line)
            } catch (error) {
                if (index === lastRecordIndex && !hasTerminatedTail) {
                    const completeLines = lines.slice(0, index)
                    this.replaceFile(
                        completeLines.length > 0 ? `${completeLines.join("\n")}\n` : "",
                    )
                    break
                }
                throw this.invalidLineError(index, error)
            }

            if (isRecord(value) && value.recordType === "session") {
                try {
                    assertSessionRecord(value)
                } catch (error) {
                    throw this.invalidLineError(index, error)
                }

                rememberSession(value.session.id)
                const existing = infoBySession.get(value.session.id)
                if (
                    existing
                    && (
                        existing.agentId !== value.session.agentId
                        || existing.createdAt !== value.session.createdAt
                    )
                ) {
                    throw this.invalidLineError(
                        index,
                        new Error("Session identity cannot change"),
                    )
                }
                infoBySession.set(value.session.id, {
                    ...cloneSessionInfo(value.session),
                    updatedAt: Math.max(
                        existing?.updatedAt ?? value.session.updatedAt,
                        value.session.updatedAt,
                    ),
                })
                this.persistedSessionIds.add(value.session.id)
                continue
            }

            if (isRecord(value) && value.recordType === "fileChangeProposal") {
                try {
                    assertFileChangeProposalJsonlRecord(value)
                    if (!infoBySession.has(value.proposal.sessionId)) {
                        throw new Error(
                            `Missing session metadata: ${value.proposal.sessionId}`,
                        )
                    }
                } catch (error) {
                    throw this.invalidLineError(index, error)
                }

                const proposals = proposalsBySession.get(value.proposal.sessionId)
                    ?? []
                const existingIndex = proposals.findIndex(
                    (proposal) => proposal.id === value.proposal.id,
                )
                if (existingIndex === -1) proposals.push(value.proposal)
                else proposals[existingIndex] = value.proposal
                proposalsBySession.set(value.proposal.sessionId, proposals)
                continue
            }

            if (isRecord(value) && value.recordType === "compaction") {
                try {
                    assertCompactionRecord(value)
                    if (!infoBySession.has(value.checkpoint.sessionId)) {
                        throw new Error(
                            `Missing session metadata: ${value.checkpoint.sessionId}`,
                        )
                    }
                } catch (error) {
                    throw this.invalidLineError(index, error)
                }

                // Checkpoints are derived summaries, not the source history. Older
                // concurrent writers could save a count from a stale in-memory view.
                // Reindexing it would hide messages the summary never incorporated.
                // Skip only an invalid anchor, retaining the last valid checkpoint
                // (or full history); malformed records still fail validation above.
                try {
                    assertCheckpointAnchor(
                        value.checkpoint,
                        messagesBySession.get(value.checkpoint.sessionId) ?? [],
                    )
                } catch (error) {
                    this.warnInvalidCheckpoint(index, error)
                    continue
                }
                const checkpoints = checkpointsBySession.get(value.checkpoint.sessionId)
                    ?? []
                checkpoints.push({ index, checkpoint: value.checkpoint })
                checkpointsBySession.set(value.checkpoint.sessionId, checkpoints)
                continue
            }

            try {
                assertMessageRecord(value)
            } catch (error) {
                throw this.invalidLineError(index, error)
            }

            const message = value.message

            const info = infoBySession.get(message.sessionId)
            if (!info) {
                throw this.invalidLineError(
                    index,
                    new Error(`Missing session metadata: ${message.sessionId}`),
                )
            }

            rememberSession(message.sessionId)
            const messages = messagesBySession.get(message.sessionId) ?? []
            // Replay the same replacement-by-ID semantics used by the live manager;
            // raw record counts are not necessarily durable message positions.
            const existingIndex = messages.findIndex((item) => item.id === message.id)
            if (existingIndex === -1) messages.push(message)
            else messages[existingIndex] = message
            // Even a replaced record may have advanced the session's timestamp.
            infoBySession.set(message.sessionId, {
                ...info,
                updatedAt: Math.max(info.updatedAt, message.createdAt),
            })
            messagesBySession.set(message.sessionId, messages)
            this.persistedSessionIds.add(message.sessionId)
        }

        for (const sessionId of sessionOrder) {
            const messages = messagesBySession.get(sessionId) ?? []
            const info = infoBySession.get(sessionId)
            if (!info) throw new Error(`Missing session metadata: ${sessionId}`)

            this.memory.createSession(info)
            for (const message of messages) this.memory.appendMessage(message)
            for (const proposal of proposalsBySession.get(sessionId) ?? []) {
                this.memory.saveFileChangeProposal(proposal)
            }
            // A later replacement may invalidate a previously complete tool sequence.
            // Recheck against the final replay before choosing the newest usable summary.
            for (const { index, checkpoint } of (
                checkpointsBySession.get(sessionId) ?? []
            ).toReversed()) {
                try {
                    this.memory.saveCompactionCheckpoint(checkpoint)
                    break
                } catch (error) {
                    this.warnInvalidCheckpoint(index, error)
                }
            }
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

    private appendRecords(records: readonly unknown[]): void {
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
            `${separator}${serializeRecords(records)}`,
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

function sessionRecord(info: ISessionInfo): ISessionRecord {
    return {
        recordType: "session",
        version: 2,
        session: cloneSessionInfo(info),
    }
}

function messageRecord(message: TAgentMessage): IMessageRecord {
    return {
        recordType: "message",
        version: 2,
        message: structuredClone(message),
    }
}

function fileChangeProposalRecord(
    proposal: IFileChangeProposalRecord,
): IFileChangeProposalJsonlRecord {
    return {
        recordType: "fileChangeProposal",
        version: 2,
        proposal: structuredClone(proposal),
    }
}

function compactionRecord(
    checkpoint: ICompactionCheckpoint,
): ICompactionRecord {
    return {
        recordType: "compaction",
        version: 2,
        checkpoint: structuredClone(checkpoint),
    }
}

function cloneSessionInfo(info: ISessionInfo): ISessionInfo {
    return {
        id: info.id,
        agentId: info.agentId,
        title: info.title,
        createdAt: info.createdAt,
        updatedAt: info.updatedAt,
    }
}

function serializeRecords(records: readonly unknown[]): string {
    return records.length === 0
        ? ""
        : `${records.map((record) => JSON.stringify(record)).join("\n")}\n`
}

function assertSessionRecord(value: unknown): asserts value is ISessionRecord {
    if (
        !isRecord(value)
        || !hasExactKeys(value, ["recordType", "version", "session"])
        || value.recordType !== "session"
        || value.version !== 2
        || !isRecord(value.session)
        || !hasExactKeys(value.session, [
            "id",
            "agentId",
            "title",
            "createdAt",
            "updatedAt",
        ])
    ) {
        throw new Error("Invalid session metadata")
    }
    assertSessionInfo(value.session)
}

function assertMessageRecord(value: unknown): asserts value is IMessageRecord {
    if (
        !isRecord(value)
        || !hasExactKeys(value, ["recordType", "version", "message"])
        || value.recordType !== "message"
        || value.version !== 2
    ) {
        throw new Error("Invalid message record")
    }
    assertDurableSessionMessage(value.message)
}

function assertFileChangeProposalJsonlRecord(
    value: unknown,
): asserts value is IFileChangeProposalJsonlRecord {
    if (
        !isRecord(value)
        || !hasExactKeys(value, ["recordType", "version", "proposal"])
        || value.recordType !== "fileChangeProposal"
        || value.version !== 2
    ) {
        throw new Error("Invalid file-change proposal record")
    }
    assertFileChangeProposalRecord(value.proposal)
}

function assertCompactionRecord(
    value: unknown,
): asserts value is ICompactionRecord {
    if (
        !isRecord(value)
        || !hasExactKeys(value, ["recordType", "version", "checkpoint"])
        || value.recordType !== "compaction"
        || value.version !== 2
    ) {
        throw new Error("Invalid compaction record")
    }
    assertCompactionCheckpoint(value.checkpoint)
}

function hasExactKeys(
    value: Record<string, unknown>,
    keys: readonly string[],
): boolean {
    const actualKeys = Object.keys(value)
    return actualKeys.length === keys.length
        && keys.every((key) => Object.hasOwn(value, key))
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
}
