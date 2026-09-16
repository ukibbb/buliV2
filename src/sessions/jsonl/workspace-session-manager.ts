import { createHash } from "node:crypto"
import { mkdirSync, readdirSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { IFileChangeProposalRecord, TAgentMessage } from "@/agent"
import type { ICompactionCheckpoint } from "@/sessions/compaction/checkpoint"
import { JsonlSessionManager } from "@/sessions/jsonl/jsonl-session-manager"
import type { ISessionInfo, ISessionManager } from "@/sessions/repository"
import { assertSessionInfo } from "@/sessions/validation"

/** Lists workspace history without owning every conversation's lock. */
export class WorkspaceSessionManager implements ISessionManager {
    private readonly directoryPath: string
    private readonly infoBySession = new Map<string, ISessionInfo>()
    private readonly openManagers = new Map<string, JsonlSessionManager>()
    private readonly stagedSessionIds = new Set<string>()
    private readonly presentationRevisions = new Map<string, number>()
    private nextPresentationRevision = 0
    private disposed = false

    constructor(options: { readonly directoryPath: string }) {
        mkdirSync(options.directoryPath, { recursive: true, mode: 0o700 })
        this.directoryPath = realpathSync(options.directoryPath)
        for (const entry of readdirSync(this.directoryPath, { withFileTypes: true })) {
            if (!entry.name.endsWith(".jsonl")) continue
            if (!entry.isFile()) {
                throw new Error(`Expected a regular conversation file: ${entry.name}`)
            }
            const reader = new JsonlSessionManager({
                filePath: join(this.directoryPath, entry.name),
                readOnly: true,
            })
            try {
                const sessions = reader.listSessions()
                if (sessions.length === 0) continue
                const info = sessions[0]!
                if (sessions.length !== 1 || entry.name !== sessionFileName(info.id)) {
                    throw new Error(`Invalid conversation file: ${entry.name}`)
                }
                this.infoBySession.set(info.id, info)
            } finally {
                reader.dispose()
            }
        }
    }

    readonly createSession = (info: ISessionInfo): void => {
        this.assertActive()
        assertSessionInfo(info)
        if (this.infoBySession.has(info.id) || this.openManagers.has(info.id)) {
            throw new Error(`Session already exists: ${info.id}`)
        }
        const manager = this.loadSessionFile(info.id)
        try {
            if (manager.listSessions().length !== 0) {
                throw new Error(`Session already exists: ${info.id}`)
            }
            manager.createSession(info)
        } catch (error) {
            manager.dispose()
            throw error
        }
        this.openManagers.set(info.id, manager)
        this.infoBySession.set(info.id, manager.getSessionInfo(info.id)!)
        this.stagedSessionIds.add(info.id)
        this.advancePresentationRevision(info.id)
    }

    /** Acquires ownership before loading; failure leaves other conversations open. */
    readonly openSession = (sessionId: string): void => {
        this.assertActive()
        if (this.openManagers.has(sessionId)) return
        const manager = this.loadSessionFile(sessionId)
        const info = manager.getSessionInfo(sessionId)
        if (!info) {
            manager.dispose()
            throw new Error(`Session does not exist: ${sessionId}`)
        }
        this.openManagers.set(sessionId, manager)
        this.infoBySession.set(sessionId, info)
        this.advancePresentationRevision(sessionId)
    }

    /** The caller must dispose the live AgentSession before releasing ownership. */
    readonly releaseSession = (sessionId: string): void => {
        this.assertActive()
        const manager = this.openManagers.get(sessionId)
        if (!manager) return
        manager.dispose()
        this.openManagers.delete(sessionId)
        if (this.stagedSessionIds.delete(sessionId)) this.infoBySession.delete(sessionId)
        this.presentationRevisions.delete(sessionId)
    }

    readonly getSessionInfo = (sessionId: string): ISessionInfo | undefined => {
        this.assertActive()
        const info = this.infoBySession.get(sessionId)
        return info === undefined ? undefined : structuredClone(info)
    }

    readonly listSessions = (): readonly ISessionInfo[] => {
        this.assertActive()
        return structuredClone([...this.infoBySession.values()])
    }

    readonly getMessages = (sessionId: string): readonly TAgentMessage[] => {
        return this.requireOpenSession(sessionId).getMessages(sessionId)
    }

    readonly appendMessage = (message: TAgentMessage): void => {
        const manager = this.requireOpenSession(message.sessionId)
        manager.appendMessage(message)
        this.infoBySession.set(message.sessionId, manager.getSessionInfo(message.sessionId)!)
        this.stagedSessionIds.delete(message.sessionId)
    }

    readonly getPresentationRevision = (sessionId: string): number => {
        this.requireOpenSession(sessionId)
        return this.presentationRevisions.get(sessionId)!
    }

    readonly getFileChangeProposals = (sessionId: string): readonly IFileChangeProposalRecord[] => {
        return this.requireOpenSession(sessionId).getFileChangeProposals(sessionId)
    }

    readonly saveFileChangeProposal = (proposal: IFileChangeProposalRecord): void => {
        this.requireOpenSession(proposal.sessionId).saveFileChangeProposal(proposal)
        this.stagedSessionIds.delete(proposal.sessionId)
        this.advancePresentationRevision(proposal.sessionId)
    }

    readonly getCompactionCheckpoint = (sessionId: string): ICompactionCheckpoint | undefined => {
        return this.requireOpenSession(sessionId).getCompactionCheckpoint(sessionId)
    }

    readonly saveCompactionCheckpoint = (checkpoint: ICompactionCheckpoint): void => {
        this.requireOpenSession(checkpoint.sessionId).saveCompactionCheckpoint(checkpoint)
        this.advancePresentationRevision(checkpoint.sessionId)
    }

    readonly deleteSession = (sessionId: string): void => {
        const manager = this.requireOpenSession(sessionId)
        manager.deleteSession(sessionId)
        this.infoBySession.delete(sessionId)
        this.stagedSessionIds.delete(sessionId)
        this.advancePresentationRevision(sessionId)
    }

    readonly dispose = (): void => {
        if (this.disposed) return
        this.disposed = true
        const errors: unknown[] = []
        for (const manager of this.openManagers.values()) {
            try {
                manager.dispose()
            } catch (error) {
                errors.push(error)
            }
        }
        this.openManagers.clear()
        this.infoBySession.clear()
        this.stagedSessionIds.clear()
        this.presentationRevisions.clear()
        if (errors.length > 0) throw new AggregateError(errors, "Unable to close workspace sessions")
    }

    private loadSessionFile(sessionId: string): JsonlSessionManager {
        const manager = new JsonlSessionManager({
            filePath: join(this.directoryPath, sessionFileName(sessionId)),
        })
        try {
            const sessions = manager.listSessions()
            if (sessions.length > 1 || sessions.some((info) => info.id !== sessionId)) {
                throw new Error(`Unexpected session metadata in conversation file: ${sessionId}`)
            }
            return manager
        } catch (error) {
            manager.dispose()
            throw error
        }
    }

    private requireOpenSession(sessionId: string): JsonlSessionManager {
        this.assertActive()
        const manager = this.openManagers.get(sessionId)
        if (!manager) throw new Error(`Session is not open: ${sessionId}`)
        return manager
    }

    private advancePresentationRevision(sessionId: string): void {
        this.presentationRevisions.set(sessionId, ++this.nextPresentationRevision)
    }

    private assertActive(): void {
        if (this.disposed) throw new Error("Workspace session manager is disposed")
    }
}

export function defaultSessionDirectoryPath(workspaceRoot = process.cwd()): string {
    const workspaceId = createHash("sha256").update(realpathSync(workspaceRoot)).digest("hex")
    return join(homedir(), ".buli", "sessions", workspaceId)
}

function sessionFileName(sessionId: string): string {
    return `${createHash("sha256").update(sessionId).digest("hex")}.jsonl`
}
