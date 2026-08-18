import type {
    IAgentModel,
    IAgentTool,
    TReasoningEffort,
} from "@/agent/agent-types"
import type {
    IBuliAgentInfo,
    IBuliApplication,
    IBuliApplicationSnapshot,
    IBuliModelInfo,
    IBuliModelSelection,
    IBuliPromptInput,
    IBuliPromptSubmission,
    IBuliSessionCreationOptions,
    ISnapshotSource,
} from "@/application/contracts"
import { generateRandomId } from "@/common"
import type {
    IModelProfile,
    ISessionInfo,
    ISessionSnapshot,
} from "@/domain"
import { AgentSession } from "@/session/agent-session"
import type { ISessionManager } from "@/session/session-manager"

export interface IBuliAgentRegistration extends IBuliAgentInfo {
    readonly systemPrompt: string
    readonly tools: readonly IAgentTool[]
}

// register model
// konkretny adapter modelu
export interface IBuliModelRegistration extends IBuliModelInfo {
    readonly model: IAgentModel
    readonly modelProfile?: IModelProfile
}

export interface IBuliRuntimeOptions {
    readonly workspaceRoot: string
    readonly manager: ISessionManager
    readonly agents: readonly IBuliAgentRegistration[]
    readonly defaultAgentId: string
    // readonly tuiControler: ITuiController
    readonly models: readonly IBuliModelRegistration[]
    readonly selection: IBuliModelSelection
    readonly now?: () => number
    readonly generateId?: () => string
}

type TBuliRuntimeListener = () => void
type TBuliRuntimeSubscribe = () => void

/** Owns and reuses one AgentSession for each requested session ID. */
export class BuliApplicationRuntime implements IBuliApplication {
    // working area
    readonly workspaceRoot: string

    private readonly manager: ISessionManager
    private readonly agents: readonly IBuliAgentRegistration[]
    private readonly defaultAgentId: string
    private readonly models: readonly IBuliModelRegistration[]
    private readonly now: () => number
    private readonly generateId: () => string
    private selection: IBuliModelSelection

    // What are agent sesions what is thier responsibility
    private readonly sessions = new Map<string, AgentSession>()
    // what does it mean ?
    private disposed = false
    private disposeTask: Promise<void> | undefined

    private snapshot: IBuliApplicationSnapshot
    private readonly listeners = new Set<TBuliRuntimeListener>()

    constructor(options: IBuliRuntimeOptions) {
        this.workspaceRoot = options.workspaceRoot
        this.manager = options.manager
        const agentIds = new Set<string>()
        this.agents = options.agents.map((registration) => {
            if (agentIds.has(registration.id)) {
                throw new Error(`Duplicate agent: ${registration.id}`)
            }
            agentIds.add(registration.id)

            return {
                ...registration,
                tools: [...registration.tools],
            }
        })
        this.defaultAgentId = options.defaultAgentId
        this.models = options.models.map((registration) => ({
            ...registration,
            reasoningEfforts: [...registration.reasoningEfforts],
            ...(registration.modelProfile === undefined
                ? {}
                : { modelProfile: structuredClone(registration.modelProfile) }),
        }))
        this.selection = { ...options.selection }
        this.now = options.now ?? Date.now
        this.generateId = options.generateId ?? generateRandomId

        this.resolveAgent(this.defaultAgentId)
        this.resolveSelectedModel()
        this.snapshot = this.createSnapshot()
    }


    readonly createSession = (
        options: IBuliSessionCreationOptions,
    ): ISessionInfo => {
        if (this.disposed) throw new Error("Buli runtime is disposed")

        const id = this.generateId()
        if (this.sessions.has(id) || this.manager.getSessionInfo(id)) {
            throw new Error(`Session already exists: ${id}`)
        }

        const agent = this.resolveAgent(options.agentId)
        const timestamp = this.now()
        const info: ISessionInfo = {
            id,
            agentId: agent.id,
            title: normalizeSessionTitle(options.title),
            createdAt: timestamp,
            updatedAt: timestamp,
        }
        const session = this.createLiveSession(info, agent)

        try {
            this.manager.createSession(info)
        } catch (error) {
            void session.dispose()
            throw error
        }

        this.sessions.set(id, session)
        return structuredClone(info)
    }

    readonly openSession = (
        sessionId: string,
    ): ISnapshotSource<ISessionSnapshot> => {
        if (this.disposed) throw new Error("Buli runtime is disposed")

        return this.getOrOpenAgentSession(sessionId)
    }

    readonly listSessions = (): readonly ISessionInfo[] => {
        if (this.disposed) throw new Error("Buli runtime is disposed")

        return [...this.manager.listSessions()].sort((left, right) =>
            right.updatedAt - left.updatedAt
            || right.createdAt - left.createdAt
            || left.id.localeCompare(right.id)
        )
    }

    readonly submitPrompt = (prompt: IBuliPromptInput): IBuliPromptSubmission => {
        if (this.disposed) throw new Error("Buli runtime is disposed")

        const createdSession = prompt.sessionId === undefined
        const sessionId = prompt.sessionId ?? this.createSession({
            agentId: this.defaultAgentId,
            title: prompt.text,
        }).id
        const session = this.getOrOpenAgentSession(sessionId)
        let run: ReturnType<AgentSession["prompt"]>
        try {
            run = session.prompt(prompt.text)
        } catch (error) {
            if (createdSession) {
                this.sessions.delete(sessionId)
                void session.dispose().catch(() => {})
                this.manager.deleteSession(sessionId)
            }
            throw error
        }
        const rollback = createdSession
            ? run.accepted.then(
                () => undefined,
                async () => {
                    await run.settled.catch(() => {})
                    await this.rollbackSession(sessionId, session)
                },
            )
            : undefined
        if (rollback) void rollback.catch(() => {})
        const accepted = this.waitForRollback(run.accepted, rollback)
        const settled = this.waitForRollback(run.settled, rollback)
        return {
            sessionId,
            runId: run.runId,
            accepted,
            settled,
        }
    }

    readonly clearSession = (sessionId: string): void => {
        if (this.disposed) throw new Error("Buli runtime is disposed")
        this.getOrOpenAgentSession(sessionId).clear()
    }

    readonly compactSession = (
        sessionId: string,
    ): ReturnType<AgentSession["compact"]> => {
        if (this.disposed) throw new Error("Buli runtime is disposed")
        return this.getOrOpenAgentSession(sessionId).compact("manual")
    }

    readonly steer = (sessionId: string, text: string): void => {
        if (this.disposed) throw new Error("Buli runtime is disposed")
        this.getOrOpenAgentSession(sessionId).steer(text)
    }

    readonly followUp = (sessionId: string, text: string): void => {
        if (this.disposed) throw new Error("Buli runtime is disposed")
        this.getOrOpenAgentSession(sessionId).followUp(text)
    }

    readonly clearQueuedMessages = (
        sessionId: string,
    ): ReturnType<AgentSession["clearQueuedMessages"]> => {
        if (this.disposed) throw new Error("Buli runtime is disposed")
        return this.getOrOpenAgentSession(sessionId).clearQueuedMessages()
    }

    readonly getSnapshot = (): IBuliApplicationSnapshot => this.snapshot
    readonly subscribe = (
        listener: TBuliRuntimeListener,
    ): TBuliRuntimeSubscribe => {
        if (this.disposed) throw new Error("Buli runtime is disposed")

        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
    }

    readonly selectModel = (modelId: string): void => {
        // Przyjmij ID modelu, który ma stać się globalnym modelem runtime.
        if (this.disposed) throw new Error("Buli runtime is disposed")
        // Zatrzymaj zmianę, jeśli runtime został już zamknięty.

        this.setSelection({
            // Zbuduj pełną następną selekcję i przekaż ją do wspólnej walidacji.
            ...this.selection,
            // Zachowaj aktualny reasoning effort.
            modelId,
            // Nadpisz wyłącznie ID wybranego modelu.
        })
        // Zastosuj zmianę atomowo albo rzuć błąd bez modyfikowania stanu.
    }

    readonly selectReasoningEffort = (
        reasoningEffort: TReasoningEffort,
    ): void => {
        // Przyjmij reasoning effort, który ma obowiązywać globalnie.
        if (this.disposed) throw new Error("Buli runtime is disposed")
        // Zatrzymaj zmianę, jeśli runtime został już zamknięty.

        this.setSelection({
            // Zbuduj pełną następną selekcję i przekaż ją do wspólnej walidacji.
            ...this.selection,
            // Zachowaj ID aktualnie wybranego modelu.
            reasoningEffort,
            // Nadpisz wyłącznie reasoning effort.
        })
        // Zastosuj zmianę atomowo albo rzuć błąd bez modyfikowania stanu.
    }

    readonly abort = async (sessionId: string): Promise<void> => {
        if (this.disposed) throw new Error("Buli runtime is disposed")
        await this.sessions.get(sessionId)?.abort()
    }

    readonly dispose = (): Promise<void> => {
        this.disposeTask ??= this.disposeInternal()
        return this.disposeTask
    }

    private async disposeInternal(): Promise<void> {
        if (this.disposed) return
        this.disposed = true

        const sessions = [...this.sessions.values()]
        this.sessions.clear()
        this.listeners.clear()
        const results = await Promise.allSettled(
            sessions.map(async (session) => session.dispose()),
        )
        const errors: unknown[] = results.flatMap((result) =>
            result.status === "rejected" ? [result.reason] : []
        )
        // Manager jest właścicielem storage/locka. Zwalniamy go po sesjach i także
        // wtedy, gdy któraś sesja zgłosiła błąd, aby shutdown nie zostawił locka.
        try {
            await this.manager.dispose?.()
        } catch (error) {
            errors.push(error)
        }
        if (errors.length > 0) {
            throw new AggregateError(errors, "Failed to dispose Buli runtime")
        }
    }

    private setSelection(selection: IBuliModelSelection): void {
        // Odbierz kompletną kandydacką selekcję modelu i reasoning effort.
        this.resolveSelectedModel(selection)
        // Sprawdź model oraz effort przed zmianą jakiegokolwiek stanu runtime.

        if (
            selection.modelId === this.selection.modelId
            && selection.reasoningEffort === this.selection.reasoningEffort
        ) {
            // Rozpoznaj, że kandydacka selekcja jest identyczna z aktualną.
            return
            // Nie twórz nowego snapshotu i nie powiadamiaj listenerów.
        }

        this.selection = { ...selection }
        // Zapisz bezpieczną kopię nowej globalnej selekcji.
        this.snapshot = this.createSnapshot()
        // Utwórz nowy immutable snapshot widoczny dla UI.

        for (const listener of [...this.listeners]) listener()
        // Powiadom kopię listy subskrybentów o gotowym snapshotcie.
    }

    private createSnapshot(): IBuliApplicationSnapshot {
        const agents = this.agents.map((registration) => Object.freeze({
            id: registration.id,
            name: registration.name,
        }))
        const models = this.models.map(
            (registration: IBuliModelRegistration) => Object.freeze({
                id: registration.id,
                name: registration.name,
                reasoningEfforts: Object.freeze([
                    ...registration.reasoningEfforts,
                ]),
            }),
        )

        return Object.freeze({
            agents: Object.freeze(agents),
            defaultAgentId: this.defaultAgentId,
            models: Object.freeze(models),
            selection: Object.freeze({ ...this.selection }),
        })
    }

    private getOrOpenAgentSession(sessionId: string): AgentSession {
        const existing = this.sessions.get(sessionId)
        if (existing) return existing

        const info = this.manager.getSessionInfo(sessionId)
        if (!info) throw new Error(`Session does not exist: ${sessionId}`)

        const agent = this.resolveAgent(info.agentId)
        const session = this.createLiveSession(info, agent)
        this.sessions.set(sessionId, session)
        return session
    }

    private async rollbackSession(
        sessionId: string,
        session: AgentSession,
    ): Promise<void> {
        const rollbackErrors: unknown[] = []
        if (this.sessions.get(sessionId) === session) {
            this.sessions.delete(sessionId)
        }
        try {
            await session.dispose()
        } catch (error) {
            rollbackErrors.push(error)
        }
        try {
            this.manager.deleteSession(sessionId)
        } catch (error) {
            rollbackErrors.push(error)
        }

        if (rollbackErrors.length > 0) {
            throw new AggregateError(
                rollbackErrors,
                "Session rollback failed",
            )
        }
    }

    private waitForRollback(
        phase: Promise<void>,
        rollback: Promise<void> | undefined,
    ): Promise<void> {
        if (!rollback) return phase
        const wrapped = phase.catch(async (phaseError: unknown) => {
            try {
                await rollback
            } catch (rollbackError) {
                throw new AggregateError(
                    [phaseError, rollbackError],
                    "Prompt failed and session rollback failed",
                )
            }
            throw phaseError
        })
        void wrapped.catch(() => {})
        return wrapped
    }

    private createLiveSession(
        info: ISessionInfo,
        agent: IBuliAgentRegistration,
    ): AgentSession {
        return new AgentSession({
            agentId: agent.id,
            sessionId: info.id,
            manager: this.manager,
            systemPrompt: agent.systemPrompt,
            resolveRunConfiguration: () => {
                const registration = this.resolveSelectedModel()

                return {
                    model: registration.model,
                    ...(registration.modelProfile === undefined
                        ? {}
                        : {
                            modelProfile: structuredClone(
                                registration.modelProfile,
                            ),
                        }),
                    reasoningEffort: this.selection.reasoningEffort,
                }
            },
            tools: agent.tools,
        })
    }

    private resolveAgent(agentId: string): IBuliAgentRegistration {
        const registration = this.agents.find((agent) => agent.id === agentId)
        if (!registration) throw new Error(`Unknown agent: ${agentId}`)

        return registration
    }

    private resolveSelectedModel(
        selection: IBuliModelSelection = this.selection,
    ): IBuliModelRegistration {
        // Użyj przekazanej selekcji albo aktualnej selekcji runtime.
        const registration = this.models.find(
            (model) => model.id === selection.modelId,
        )
        // Znajdź wykonywalną rejestrację odpowiadającą wybranemu ID.

        if (!registration) {
            // Wykryj selekcję wskazującą model nieobecny w registry.
            throw new Error(`Unknown model: ${selection.modelId}`)
            // Przerwij operację przed zmianą stanu.
        }

        if (!registration.reasoningEfforts.includes(selection.reasoningEffort)) {
            // Sprawdź, czy wybrany model obsługuje kandydacki effort.
            throw new Error(
                `Unsupported reasoning effort: ${selection.reasoningEffort}`,
            )
            // Przerwij operację przed zmianą stanu.
        }
        return registration
        // Zwróć adapter modelu dopiero po przejściu całej walidacji.
    }
}

function normalizeSessionTitle(title: string): string {
    const normalized = title.replace(/\s+/g, " ").trim()
    if (!normalized) throw new Error("Session title cannot be empty")

    return [...normalized].slice(0, 60).join("")
}
