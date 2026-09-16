import type {
    IAgentModel,
    IRuntimeAgentTool,
    IModelProfile,
    IToolOutputStore,
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
    IBuliPromptRun,
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
import type {
    FileChangeProposalStore,
    TFdPathSearcher,
} from "@/tools"

type TBuliRuntimeListener = () => void
type TBuliRuntimeSubscribe = () => void

export interface IBuliAgentRuntimeConfig extends IBuliAgentDisplayInfo {
    readonly systemPrompt: string
    readonly tools: readonly IRuntimeAgentTool[]
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
    // Opts into discovery-gated startup (requires loadModels). This in-memory
    // priority order applies only to the first successful catalog and is not persisted.
    readonly preferredModelIds?: readonly string[]
    readonly searchPaths?: TBuliPathSearcher
    readonly now?: () => number
    readonly generateId?: () => string
    readonly toolOutputStore?: IToolOutputStore
    readonly fileChangeProposalStore?: FileChangeProposalStore
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
    private readonly preferredModelIds: readonly string[] | undefined
    private readonly pathSearcher: TBuliPathSearcher | undefined
    private readonly now: () => number
    private readonly generateId: () => string
    private readonly toolOutputStore: IToolOutputStore | undefined
    private readonly fileChangeProposalStore: FileChangeProposalStore | undefined
    private readonly lifetime = new AbortController()

    private selection: IBuliModelSelection
    private modelRefreshTask: Promise<void> | undefined
    private modelCatalog: IBuliApplicationSnapshot["modelCatalog"]
    // Even selecting the current value is explicit intent, unlike the private
    // bootstrap defaults. Keep model and effort intent separate during discovery.
    private modelManuallySelected = false
    private manuallySelectedReasoningEffort: TReasoningEffort | undefined

    // What are agent sesions what is thier responsibility
    private readonly sessions = new Map<string, AgentSession>()
    private readonly sessionCloseTasks = new Map<string, Promise<void>>()
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
        if (options.preferredModelIds !== undefined && !this.loadModels) {
            throw new Error("preferredModelIds requires loadModels")
        }
        this.preferredModelIds = options.preferredModelIds === undefined
            ? undefined
            : [...options.preferredModelIds]
        this.modelCatalog = this.preferredModelIds === undefined
            ? undefined
            : { status: "loading" }
        this.pathSearcher = options.searchPaths
        this.selection = { ...options.selection }
        this.now = options.now ?? Date.now
        this.generateId = options.generateId ?? generateRandomId
        this.toolOutputStore = options.toolOutputStore
        this.fileChangeProposalStore = options.fileChangeProposalStore

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
        this.manager.createSession(info)
        try {
            const session = this.createLiveSession(info, agent)
            this.sessions.set(id, session)
        } catch (error) {
            try {
                this.manager.deleteSession(id)
                this.manager.releaseSession?.(id)
            } catch (cleanupError) {
                throw new AggregateError(
                    [error, cleanupError],
                    "Session creation failed and cleanup failed",
                )
            }
            throw error
        }

        return structuredClone(info)
    }

    readonly openSession = (
        sessionId: string,
    ): ISnapshotSource<ISessionSnapshot> => {
        if (this.disposed) throw new Error("Buli runtime is disposed")

        return this.getOrOpenAgentSession(sessionId)
    }

    readonly closeSession = (sessionId: string): Promise<void> => {
        if (this.disposed) {
            return Promise.reject(new Error("Buli runtime is disposed"))
        }
        const existingTask = this.sessionCloseTasks.get(sessionId)
        if (existingTask) return existingTask

        const session = this.sessions.get(sessionId)
        if (!session) return Promise.resolve()

        const task = Promise.resolve().then(async () => {
            await session.dispose()
            this.manager.releaseSession?.(sessionId)
            this.sessions.delete(sessionId)
            this.sessionCloseTasks.delete(sessionId)
        })
        this.sessionCloseTasks.set(sessionId, task)
        return task
    }

    readonly listSessions = (): readonly ISessionInfo[] => {
        if (this.disposed) throw new Error("Buli runtime is disposed")

        return [...this.manager.listSessions()].sort((left, right) =>
            right.updatedAt - left.updatedAt
            || right.createdAt - left.createdAt
            || left.id.localeCompare(right.id)
        )
    }

    readonly submitPrompt = (prompt: IBuliPromptInput): IBuliPromptRun => {
        if (this.disposed) throw new Error("Buli runtime is disposed")
        // Reject synchronously before creating a session or persisting a prompt;
        // the startup registration is not permission to execute an unknown model.
        this.assertModelCatalogReady()

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
                void this.rollbackSession(sessionId, session).catch((rollbackError: unknown) => {
                    console.error(`Session rollback failed: ${sessionId}`, rollbackError)
                })
            }
            throw error
        }
        const rollbackOnInitialPromptFailure = createdSession
            ? run.initialPromptProcessed.then(
                () => undefined,
                async () => {
                    await run.runFinished.catch(() => { })
                    await this.rollbackSession(sessionId, session)
                },
            )
            : undefined
        if (rollbackOnInitialPromptFailure) {
            void rollbackOnInitialPromptFailure.catch(() => { })
        }
        const promptPersisted = this.rejectAfterRollback(
            run.initialPromptProcessed,
            rollbackOnInitialPromptFailure,
        )
        const runFinished = this.rejectAfterRollback(
            run.runFinished,
            rollbackOnInitialPromptFailure,
        )
        return {
            sessionId,
            runId: run.runId,
            promptPersisted,
            runFinished,
        }
    }

    readonly compactSession = (
        sessionId: string,
    ): ReturnType<AgentSession["compact"]> => {
        if (this.disposed) throw new Error("Buli runtime is disposed")
        this.assertModelCatalogReady()
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

        const completion = Promise.withResolvers<void>()
        const task = completion.promise.finally(() => {
            if (this.modelRefreshTask === task) this.modelRefreshTask = undefined
        })
        // Loading observers (and injected loaders) can call refreshModels again.
        // Install the shared flight and cancellation waiter before invoking either.
        this.modelRefreshTask = task
        const result = waitWithSignal(task, signal)
        if (this.modelCatalog && this.modelCatalog.status !== "ready") {
            this.modelCatalog = { status: "loading" }
            this.snapshot = this.createSnapshot()
            this.notifyListeners()
        }
        void this.refreshModelsInternal(signal).then(
            completion.resolve,
            completion.reject,
        )
        return result
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
        }, "modelId")
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
        }, "reasoningEffort")
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
        // An injected catalog loader may ignore cancellation. It cannot commit
        // after disposal, so observe rejection without holding shutdown open.
        void modelRefreshTask?.catch(() => {})
        this.sessions.clear()
        this.listeners.clear()
        const results = await Promise.allSettled(
            sessions.map(async (session) => session.dispose()),
        )
        const errors: unknown[] = results.flatMap((result) =>
            result.status === "rejected" ? [result.reason] : []
        )
        if (errors.length > 0) {
            throw new AggregateError(errors, "Failed to stop Buli runtime sessions")
        }
        try {
            await this.toolOutputStore?.dispose()
        } catch (error) {
            errors.push(error)
        }
        try {
            await this.manager.dispose?.()
        } catch (error) {
            errors.push(error)
        }
        if (errors.length > 0) {
            throw new AggregateError(errors, "Failed to dispose Buli runtime")
        }
    }

    private setSelection(
        selection: IBuliModelSelection,
        field: keyof IBuliModelSelection,
    ): void {
        // Odbierz kompletną kandydacką selekcję modelu i reasoning effort.
        this.resolveSelectedModel(selection)
        // Sprawdź model oraz effort przed zmianą jakiegokolwiek stanu runtime.

        if (field === "modelId") this.modelManuallySelected = true
        else this.manuallySelectedReasoningEffort = selection.reasoningEffort
        const dismissNotice = this.modelCatalog?.status === "ready"
            && this.modelCatalog.message !== undefined
        if (
            selection.modelId === this.selection.modelId
            && selection.reasoningEffort === this.selection.reasoningEffort
            && !dismissNotice
        ) {
            // Rozpoznaj, że kandydacka selekcja jest identyczna z aktualną.
            return
            // Nie twórz nowego snapshotu i nie powiadamiaj listenerów.
        }

        this.selection = { ...selection }
        // Zapisz bezpieczną kopię nowej globalnej selekcji.
        // A valid manual choice acknowledges a non-blocking catalog notice, even
        // when the chosen value is unchanged. It cannot bypass initial readiness.
        if (dismissNotice) this.modelCatalog = { status: "ready" }
        this.snapshot = this.createSnapshot()
        // Utwórz nowy immutable snapshot widoczny dla UI.

        for (const session of this.sessions.values()) {
            session.refreshContextUsage()
        }

        this.notifyListeners()
        // Powiadom kopię listy subskrybentów o gotowym snapshotcie.
    }

    private notifyListeners(): void {
        for (const listener of [...this.listeners]) {
            if (this.disposed) break
            try {
                listener()
            } catch (error) {
                // Observers cannot turn a committed catalog into a failed refresh
                // or prevent other subscribers from seeing the same ready state.
                console.error("Runtime observer failed", error)
            }
        }
    }

    private createSnapshot(
        modelsSource: readonly IBuliModelRuntimeConfig[] = this.models,
        selection: IBuliModelSelection = this.selection,
        modelCatalog = this.modelCatalog,
    ): IBuliApplicationSnapshot {
        const agents = this.agents.map((registration) => Object.freeze({
            id: registration.id,
            name: registration.name,
        }))
        const visibleModels = modelCatalog && modelCatalog.status !== "ready"
            ? []
            : modelsSource
        const models = visibleModels.map(
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
            ...(modelCatalog === undefined
                ? {}
                : { modelCatalog: Object.freeze({ ...modelCatalog }) }),
        })
    }

    private async refreshModelsInternal(signal?: AbortSignal): Promise<void> {
        const loadModels = this.loadModels
        if (!loadModels) return
        const refreshSignal = signal
            ? AbortSignal.any([signal, this.lifetime.signal])
            : this.lifetime.signal

        try {
            refreshSignal.throwIfAborted()
            const loaded = await loadModels(refreshSignal)
            refreshSignal.throwIfAborted()
            const registrations = copyModelRegistrations(loaded)
            const initialDiscovery = this.modelCatalog !== undefined
                && this.modelCatalog.status !== "ready"
            const previousRegistration = this.models.find(
                (model) => model.id === this.selection.modelId,
            )
            const manualModelAvailable = this.modelManuallySelected
                && registrations.some((model) => model.id === this.selection.modelId)
            // Read intent after awaiting the loader so a picker change made during
            // the request wins. Provisional effort is not a user choice: the first
            // discovered model supplies its default unless effort was explicit.
            // A model switch's provisional effort downgrade must not erase intent.
            const selection = reconcileSelection(
                registrations,
                this.selection,
                previousRegistration?.fallbackSelectionId,
                initialDiscovery && !manualModelAvailable
                    ? this.preferredModelIds
                    : undefined,
                initialDiscovery
                    ? this.manuallySelectedReasoningEffort
                    : this.selection.reasoningEffort,
            )
            const requestedModelId = initialDiscovery && !this.modelManuallySelected
                ? this.preferredModelIds?.[0] ?? this.selection.modelId
                : this.selection.modelId
            const modelCatalog: IBuliApplicationSnapshot["modelCatalog"] =
                this.modelCatalog === undefined ? undefined : {
                    status: "ready",
                    ...(requestedModelId === selection.modelId ? {} : {
                        message: `Model "${requestedModelId}" was not returned in the model catalog for your signed-in ChatGPT account. Availability may depend on your plan or account permissions. Using "${selection.modelId}" instead.`,
                    }),
                }
            const snapshot = this.createSnapshot(registrations, selection, modelCatalog)
            refreshSignal.throwIfAborted()
            if (this.disposed) throw new Error("Buli runtime is disposed")

            // Validate everything before replacing private adapters and public data
            // together. Only this successful commit consumes the initial preference;
            // active Agent runs keep their already-captured configuration.
            this.models = registrations
            this.selection = selection
            this.modelCatalog = modelCatalog
            this.snapshot = snapshot
        } catch (error) {
            if (!this.disposed && this.modelCatalog) {
                const ready = this.modelCatalog.status === "ready"
                const message = error instanceof Error ? error.message : String(error)
                this.modelCatalog = {
                    status: ready ? "ready" : "error",
                    message: ready
                        ? `Model catalog refresh failed; using the previous catalog. ${message}`
                        : `Model catalog unavailable. Retry discovery after signing in if needed. ${message}`,
                }
                this.snapshot = this.createSnapshot()
                this.notifyListeners()
            }
            throw error
        }
        for (const session of this.sessions.values()) {
            session.refreshContextUsage()
        }
        this.notifyListeners()
    }

    private getOrOpenAgentSession(sessionId: string): AgentSession {
        if (this.sessionCloseTasks.has(sessionId)) {
            throw new Error(`Session is closing or failed to close: ${sessionId}`)
        }
        const existing = this.sessions.get(sessionId)
        if (existing) return existing

        this.manager.openSession?.(sessionId)
        try {
            const info = this.manager.getSessionInfo(sessionId)
            if (!info) throw new Error(`Session does not exist: ${sessionId}`)

            const agent = this.resolveAgent(info.agentId)
            const session = this.createLiveSession(info, agent)
            this.sessions.set(sessionId, session)
            return session
        } catch (error) {
            try {
                this.manager.releaseSession?.(sessionId)
            } catch (cleanupError) {
                throw new AggregateError(
                    [error, cleanupError],
                    "Session opening failed and cleanup failed",
                )
            }
            throw error
        }
    }

    private async rollbackSession(
        sessionId: string,
        session: AgentSession,
    ): Promise<void> {
        if (this.sessionCloseTasks.has(sessionId)) {
            throw new Error(`Cannot roll back a session that is already closing: ${sessionId}`)
        }
        const task = Promise.resolve().then(async () => {
            await session.dispose()
            this.manager.deleteSession(sessionId)
            this.manager.releaseSession?.(sessionId)
            this.sessions.delete(sessionId)
            this.sessionCloseTasks.delete(sessionId)
        })
        this.sessionCloseTasks.set(sessionId, task)
        await task
    }

    private rejectAfterRollback(
        phase: Promise<void>,
        rollbackOnInitialPromptFailure: Promise<void> | undefined,
    ): Promise<void> {
        if (!rollbackOnInitialPromptFailure) return phase
        const wrapped = phase.catch(async (phaseError: unknown) => {
            try {
                await rollbackOnInitialPromptFailure
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
                // Session browsing tolerates an unresolved configuration. Throwing
                // here also keeps provisional context limits out of its telemetry.
                this.assertModelCatalogReady()
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
            ...(this.toolOutputStore === undefined
                ? {}
                : { toolOutputStore: this.toolOutputStore }),
            ...(this.fileChangeProposalStore === undefined
                ? {}
                : { fileChangeProposalStore: this.fileChangeProposalStore }),
        })
    }

    private resolveAgent(agentId: string): IBuliAgentRuntimeConfig {
        const registration = this.agents.find((agent) => agent.id === agentId)
        if (!registration) throw new Error(`Unknown agent: ${agentId}`)

        return registration
    }

    private assertModelCatalogReady(): void {
        if (this.modelCatalog && this.modelCatalog.status !== "ready") {
            throw new Error(this.modelCatalog.message
                ?? "Model catalog is loading. Wait for discovery before generating.")
        }
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
    preferredModelIds?: readonly string[],
    reasoningEffort?: TReasoningEffort,
): IBuliModelSelection {
    const preferred = preferredModelIds?.map((id) => registrations.find(
        (model) => model.id === id,
    )).find((model) => model !== undefined)
    const registration = preferred ?? registrations.find(
        (model) => model.id === selection.modelId,
    ) ?? registrations.find(
        (model) => model.id === fallbackSelectionId,
    ) ?? registrations[0]
    if (!registration) throw new Error("At least one model must be registered")

    return {
        modelId: registration.id,
        reasoningEffort: reasoningEffort !== undefined && registration.reasoningEfforts.includes(
            reasoningEffort,
        )
            ? reasoningEffort
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
