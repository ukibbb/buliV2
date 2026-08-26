import type {
    IAgentModel,
    IAgentTool,
    IModelProfile,
    TReasoningEffort,
    TToolApprovalDecision,
} from "@/agent"
import type {
    IBuliAgentDisplayInfo,
    IBuliApplication,
    IBuliApplicationSnapshot,
    IBuliModelDisplayInfo,
    IBuliModelSelection,
    IBuliPathSuggestion,
    IBuliPromptInput,
    IBuliPromptSubmission,
    IBuliSessionCreationOptions,
    ISnapshotSource,
} from "@/app/contracts"
import { generateRandomId } from "@/common/ids"
import {
    AgentSession,
    type ISessionInfo,
    type ISessionManager,
    type ISessionSnapshot,
} from "@/sessions"
import type { TFdPathSearcher } from "@/tools"

type TBuliRuntimeListener = () => void
type TBuliRuntimeSubscribe = () => void

export interface IBuliAgentRuntimeConfig extends IBuliAgentDisplayInfo {
    readonly systemPrompt: string
    readonly tools: readonly IAgentTool[]
}

export interface IBuliModelRuntimeConfig extends IBuliModelDisplayInfo {
    readonly model: IAgentModel
    readonly modelProfile?: IModelProfile
    readonly providerAccountId?: string
    readonly fallbackSelectionId?: string
    readonly defaultReasoningEffort: TReasoningEffort
}

export type TBuliModelRegistrationLoader = (
    signal: AbortSignal,
) => Promise<readonly IBuliModelRuntimeConfig[]>

export type TBuliPathSearcher = TFdPathSearcher

export interface IBuliRuntimeOptions {
    readonly workspaceRoot: string
    readonly manager: ISessionManager
    readonly agents: readonly IBuliAgentRuntimeConfig[]
    readonly defaultAgentId: string
    // readonly tuiControler: ITuiController
    readonly models: readonly IBuliModelRuntimeConfig[]
    readonly selection: IBuliModelSelection
    readonly loadModels?: TBuliModelRegistrationLoader
    readonly searchPaths?: TBuliPathSearcher
    readonly now?: () => number
    readonly generateId?: () => string
}


/** Owns and reuses one AgentSession for each requested session ID. */
export class BuliApplicationRuntime implements IBuliApplication {
    // working area
    readonly workspaceRoot: string

    private readonly manager: ISessionManager
    private readonly agents: readonly IBuliAgentRuntimeConfig[]
    private readonly defaultAgentId: string
    private models: readonly IBuliModelRuntimeConfig[]
    private readonly loadModels: TBuliModelRegistrationLoader | undefined
    private readonly pathSearcher: TBuliPathSearcher | undefined
    private readonly now: () => number
    private readonly generateId: () => string
    private readonly lifetime = new AbortController()

    private selection: IBuliModelSelection
    private modelRefreshTask: Promise<void> | undefined

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
        this.models = copyModelRegistrations(options.models)
        this.loadModels = options.loadModels
        this.pathSearcher = options.searchPaths
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
            run = session.prompt(prompt)
        } catch (error) {
            if (createdSession) {
                this.sessions.delete(sessionId)
                void session.dispose().catch(() => { })
                this.manager.deleteSession(sessionId)
            }
            throw error
        }
        const rollback = createdSession
            ? run.accepted.then(
                () => undefined,
                async () => {
                    await run.settled.catch(() => { })
                    await this.rollbackSession(sessionId, session)
                },
            )
            : undefined
        if (rollback) void rollback.catch(() => { })
        const accepted = this.waitForRollback(run.accepted, rollback)
        const settled = this.waitForRollback(run.settled, rollback)
        return {
            sessionId,
            runId: run.runId,
            accepted,
            settled,
        }
    }

    readonly compactSession = (
        sessionId: string,
    ): ReturnType<AgentSession["compact"]> => {
        if (this.disposed) throw new Error("Buli runtime is disposed")
        return this.getOrOpenAgentSession(sessionId).compact("manual")
    }

    readonly steer = (
        sessionId: string,
        text: string,
        resources: Omit<IBuliPromptInput, "sessionId" | "text"> = {},
    ): void => {
        if (this.disposed) throw new Error("Buli runtime is disposed")
        this.getOrOpenAgentSession(sessionId).steer({ text, ...resources })
    }

    readonly followUp = (
        sessionId: string,
        text: string,
        resources: Omit<IBuliPromptInput, "sessionId" | "text"> = {},
    ): void => {
        if (this.disposed) throw new Error("Buli runtime is disposed")
        this.getOrOpenAgentSession(sessionId).followUp({ text, ...resources })
    }

    readonly searchPaths = async (
        query: string,
        signal?: AbortSignal,
    ): Promise<readonly IBuliPathSuggestion[]> => {
        if (this.disposed) throw new Error("Buli runtime is disposed")
        if (!this.pathSearcher) return []
        const operationSignal = signal
            ? AbortSignal.any([signal, this.lifetime.signal])
            : this.lifetime.signal
        return structuredClone(await this.pathSearcher(query, operationSignal))
    }

    readonly clearQueuedMessages = (
        sessionId: string,
    ): ReturnType<AgentSession["clearQueuedMessages"]> => {
        if (this.disposed) throw new Error("Buli runtime is disposed")
        return this.getOrOpenAgentSession(sessionId).clearQueuedMessages()
    }

    readonly resolveToolApproval = (
        sessionId: string,
        approvalId: string,
        decision: TToolApprovalDecision,
    ): void => {
        if (this.disposed) throw new Error("Buli runtime is disposed")
        this.getOrOpenAgentSession(sessionId).resolveToolApproval(
            approvalId,
            decision,
        )
    }

    readonly getSnapshot = (): IBuliApplicationSnapshot => this.snapshot
    readonly subscribe = (
        listener: TBuliRuntimeListener,
    ): TBuliRuntimeSubscribe => {
        if (this.disposed) throw new Error("Buli runtime is disposed")

        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
    }

    readonly refreshModels = (signal?: AbortSignal): Promise<void> => {
        if (this.disposed) {
            return Promise.reject(new Error("Buli runtime is disposed"))
        }
        if (signal?.aborted) return Promise.reject(signal.reason)
        if (!this.loadModels) return Promise.resolve()
        if (this.modelRefreshTask) {
            return waitWithSignal(this.modelRefreshTask, signal)
        }

        const task = this.refreshModelsInternal(signal).finally(() => {
            if (this.modelRefreshTask === task) this.modelRefreshTask = undefined
        })
        this.modelRefreshTask = task
        return waitWithSignal(task, signal)
    }

    readonly selectModel = (modelId: string): void => {
        // Przyjmij ID modelu, który ma stać się globalnym modelem runtime.
        if (this.disposed) throw new Error("Buli runtime is disposed")
        // Zatrzymaj zmianę, jeśli runtime został już zamknięty.

        const registration = this.resolveModel(modelId)
        this.setSelection({
            // Zbuduj pełną następną selekcję i przekaż ją do wspólnej walidacji.
            ...this.selection,
            modelId,
            reasoningEffort: registration.reasoningEfforts.includes(
                this.selection.reasoningEffort,
            )
                ? this.selection.reasoningEffort
                : registration.defaultReasoningEffort,
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
        if (!this.lifetime.signal.aborted) {
            this.lifetime.abort(abortError("Buli runtime is shutting down"))
        }

        const sessions = [...this.sessions.values()]
        const modelRefreshTask = this.modelRefreshTask
        this.sessions.clear()
        this.listeners.clear()
        const results = await Promise.allSettled(
            sessions.map(async (session) => session.dispose()),
        )
        await modelRefreshTask?.catch(() => {})
        const errors: unknown[] = results.flatMap((result) =>
            result.status === "rejected" ? [result.reason] : []
        )
        // Manager jest właścicielem zasobów storage. Zwalniamy je po sesjach także
        // wtedy, gdy któraś sesja zgłosiła błąd.
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

        for (const session of this.sessions.values()) {
            session.refreshContextUsage()
        }

        for (const listener of [...this.listeners]) listener()
        // Powiadom kopię listy subskrybentów o gotowym snapshotcie.
    }

    private createSnapshot(
        modelsSource: readonly IBuliModelRuntimeConfig[] = this.models,
        selection: IBuliModelSelection = this.selection,
    ): IBuliApplicationSnapshot {
        const agents = this.agents.map((registration) => Object.freeze({
            id: registration.id,
            name: registration.name,
        }))
        const models = modelsSource.map(
            (registration: IBuliModelRuntimeConfig) => Object.freeze({
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
            selection: Object.freeze({ ...selection }),
        })
    }

    private async refreshModelsInternal(signal?: AbortSignal): Promise<void> {
        const loadModels = this.loadModels
        if (!loadModels) return
        const refreshSignal = signal
            ? AbortSignal.any([signal, this.lifetime.signal])
            : this.lifetime.signal

        const registrations = copyModelRegistrations(
            await loadModels(refreshSignal),
        )
        refreshSignal.throwIfAborted()
        const previousRegistration = this.models.find(
            (model) => model.id === this.selection.modelId,
        )
        const selection = reconcileSelection(
            registrations,
            this.selection,
            previousRegistration?.fallbackSelectionId,
        )
        const snapshot = this.createSnapshot(registrations, selection)
        refreshSignal.throwIfAborted()
        if (this.disposed) throw new Error("Buli runtime is disposed")

        this.models = registrations
        this.selection = selection
        this.snapshot = snapshot
        for (const session of this.sessions.values()) {
            session.refreshContextUsage()
        }
        for (const listener of [...this.listeners]) listener()
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
        void wrapped.catch(() => { })
        return wrapped
    }

    private createLiveSession(
        info: ISessionInfo,
        agent: IBuliAgentRuntimeConfig,
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
                    ...(registration.providerAccountId === undefined
                        ? {}
                        : {
                            providerAccountId:
                                registration.providerAccountId,
                        }),
                    reasoningEffort: this.selection.reasoningEffort,
                }
            },
            tools: agent.tools,
        })
    }

    private resolveAgent(agentId: string): IBuliAgentRuntimeConfig {
        const registration = this.agents.find((agent) => agent.id === agentId)
        if (!registration) throw new Error(`Unknown agent: ${agentId}`)

        return registration
    }

    private resolveSelectedModel(
        selection: IBuliModelSelection = this.selection,
    ): IBuliModelRuntimeConfig {
        // Użyj przekazanej selekcji albo aktualnej selekcji runtime.
        const registration = this.resolveModel(selection.modelId)
        // Znajdź wykonywalną rejestrację odpowiadającą wybranemu ID.

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

    private resolveModel(modelId: string): IBuliModelRuntimeConfig {
        const registration = this.models.find((model) => model.id === modelId)
        if (!registration) throw new Error(`Unknown model: ${modelId}`)
        return registration
    }
}

function copyModelRegistrations(
    registrations: readonly IBuliModelRuntimeConfig[],
): readonly IBuliModelRuntimeConfig[] {
    if (registrations.length === 0) {
        throw new Error("At least one model must be registered")
    }

    const ids = new Set<string>()
    const copied = registrations.map((registration) => {
        if (!registration.id.trim()) throw new Error("Model ID cannot be empty")
        if (!registration.name.trim()) {
            throw new Error(`Model name cannot be empty: ${registration.id}`)
        }
        if (
            registration.fallbackSelectionId !== undefined
            && !registration.fallbackSelectionId.trim()
        ) {
            throw new Error(
                `Model fallback selection ID cannot be empty: ${registration.id}`,
            )
        }
        if (registration.fallbackSelectionId === registration.id) {
            throw new Error(`Model fallback cannot reference itself: ${registration.id}`)
        }
        if (ids.has(registration.id)) {
            throw new Error(`Duplicate model: ${registration.id}`)
        }
        ids.add(registration.id)

        const reasoningEfforts = [...registration.reasoningEfforts]
        if (reasoningEfforts.length === 0) {
            throw new Error(`Model has no reasoning efforts: ${registration.id}`)
        }
        if (new Set(reasoningEfforts).size !== reasoningEfforts.length) {
            throw new Error(`Model has duplicate reasoning efforts: ${registration.id}`)
        }
        if (!reasoningEfforts.includes(registration.defaultReasoningEffort)) {
            throw new Error(
                `Model default reasoning effort is unsupported: ${registration.id}`,
            )
        }

        return {
            ...registration,
            reasoningEfforts,
            ...(registration.modelProfile === undefined
                ? {}
                : { modelProfile: structuredClone(registration.modelProfile) }),
        }
    })
    for (const registration of copied) {
        if (
            registration.fallbackSelectionId !== undefined
            && !ids.has(registration.fallbackSelectionId)
        ) {
            throw new Error(
                `Unknown model fallback: ${registration.fallbackSelectionId}`,
            )
        }
    }
    return copied
}

function reconcileSelection(
    registrations: readonly IBuliModelRuntimeConfig[],
    selection: IBuliModelSelection,
    fallbackSelectionId?: string,
): IBuliModelSelection {
    const registration = registrations.find(
        (model) => model.id === selection.modelId,
    ) ?? registrations.find(
        (model) => model.id === fallbackSelectionId,
    ) ?? registrations[0]
    if (!registration) throw new Error("At least one model must be registered")

    return {
        modelId: registration.id,
        reasoningEffort: registration.reasoningEfforts.includes(
            selection.reasoningEffort,
        )
            ? selection.reasoningEffort
            : registration.defaultReasoningEffort,
    }
}

function normalizeSessionTitle(title: string): string {
    const normalized = title.replace(/\s+/g, " ").trim()
    if (!normalized) throw new Error("Session title cannot be empty")

    return [...normalized].slice(0, 60).join("")
}

function abortError(message: string): Error {
    const error = new Error(message)
    error.name = "AbortError"
    return error
}

function waitWithSignal<T>(
    promise: Promise<T>,
    signal?: AbortSignal,
): Promise<T> {
    if (!signal) return promise
    if (signal.aborted) return Promise.reject(signal.reason)

    const completion = Promise.withResolvers<T>()
    let settled = false
    const finish = (run: () => void): void => {
        if (settled) return
        settled = true
        signal.removeEventListener("abort", abort)
        run()
    }
    const abort = (): void => finish(() => completion.reject(signal.reason))
    signal.addEventListener("abort", abort, { once: true })
    promise.then(
        (value) => finish(() => completion.resolve(value)),
        (error: unknown) => finish(() => completion.reject(error)),
    )
    return completion.promise
}
