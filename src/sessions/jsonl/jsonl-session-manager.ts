import { createHash, randomUUID } from "node:crypto"
import {
    appendFileSync,
    chmodSync,
    existsSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { AgentMessage } from "@/agent"
import {
    assertCheckpointAnchor,
    type ICompactionCheckpoint,
} from "@/sessions/compaction/checkpoint"
import { InMemorySessionManager } from "@/sessions/in-memory-session-manager"
import type {
    ISessionInfo,
    ISessionManager,
} from "@/sessions/repository"
import {
    assertCompactionCheckpoint,
    assertDurableSessionMessage,
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
    readonly message: AgentMessage
}

interface ICompactionRecord {
    readonly recordType: "compaction"
    readonly version: 2
    readonly checkpoint: ICompactionCheckpoint
}

/** Persists session metadata and direct Agent messages as JSONL records. */
export class JsonlSessionManager implements ISessionManager {
    private readonly memory = new InMemorySessionManager()
    private readonly persistedSessionIds = new Set<string>()
    private readonly filePath: string
    private disposed = false

    constructor(options: IJsonlSessionManagerOptions) {
        this.filePath = options.filePath
        mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 })
        this.load()
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
    ): readonly AgentMessage[] => {
        this.assertActive()
        return this.memory.getMessages(sessionId)
    }

    readonly appendMessage = (message: AgentMessage): void => {
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
    }

    private load(): void {
        if (!existsSync(this.filePath)) return

        const contents = readFileSync(this.filePath, "utf8")
        const lines = contents.split("\n")
        const hasTerminatedTail = contents.endsWith("\n")
        const lastRecordIndex = lines.findLastIndex((line) => line.trim().length > 0)
        const infoBySession = new Map<string, ISessionInfo>()
        const messagesBySession = new Map<string, AgentMessage[]>()
        const checkpointsBySession = new Map<string, ICompactionCheckpoint>()
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
                throw invalidLineError(index, error)
            }

            if (isRecord(value) && value.recordType === "session") {
                try {
                    assertSessionRecord(value)
                } catch (error) {
                    throw invalidLineError(index, error)
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
                    throw invalidLineError(
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

            if (isRecord(value) && value.recordType === "compaction") {
                try {
                    assertCompactionRecord(value)
                    if (!infoBySession.has(value.checkpoint.sessionId)) {
                        throw new Error(
                            `Missing session metadata: ${value.checkpoint.sessionId}`,
                        )
                    }
                    assertCheckpointAnchor(
                        value.checkpoint,
                        messagesBySession.get(value.checkpoint.sessionId) ?? [],
                    )
                } catch (error) {
                    throw invalidLineError(index, error)
                }
                checkpointsBySession.set(
                    value.checkpoint.sessionId,
                    value.checkpoint,
                )
                continue
            }

            try {
                assertMessageRecord(value)
            } catch (error) {
                throw invalidLineError(index, error)
            }

            const message = value.message

            if (!infoBySession.has(message.sessionId)) {
                throw invalidLineError(
                    index,
                    new Error(`Missing session metadata: ${message.sessionId}`),
                )
            }

            rememberSession(message.sessionId)
            const messages = messagesBySession.get(message.sessionId) ?? []
            messages.push(message)
            messagesBySession.set(message.sessionId, messages)
            this.persistedSessionIds.add(message.sessionId)
        }

        for (const sessionId of sessionOrder) {
            const messages = messagesBySession.get(sessionId) ?? []
            const info = infoBySession.get(sessionId)
            if (!info) throw new Error(`Missing session metadata: ${sessionId}`)

            this.memory.createSession(info)
            for (const message of messages) this.memory.appendMessage(message)
            const checkpoint = checkpointsBySession.get(sessionId)
            if (checkpoint) this.memory.saveCompactionCheckpoint(checkpoint)
        }
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
        const contents = existsSync(this.filePath)
            ? readFileSync(this.filePath, "utf8")
            : ""
        const separator = contents.length === 0 || contents.endsWith("\n")
            ? ""
            : "\n"
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

function invalidLineError(index: number, cause: unknown): Error {
    return new Error(`Invalid session JSONL record on line ${index + 1}`, { cause })
}

function sessionRecord(info: ISessionInfo): ISessionRecord {
    return {
        recordType: "session",
        version: 2,
        session: cloneSessionInfo(info),
    }
}

function messageRecord(message: AgentMessage): IMessageRecord {
    return {
        recordType: "message",
        version: 2,
        message: structuredClone(message),
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
