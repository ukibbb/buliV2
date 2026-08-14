import { realpath } from "node:fs/promises"

import type {
    IAgentModel,
    IAgentTool,
    TReasoningEffort,
} from "@/agent/agent-types"
import { systemPrompt } from "@/agent/agents-prompts"
import { DEFAULT_OPENAI_MODEL_ID, OpenAiAgentModel } from "@/providers/openai/openai-agent-model"
import { AgentSession } from "@/session/agent-session"
import {
    defaultSessionFilePath,
    JsonlSessionManager,
} from "@/session/jsonl-session-manager"
import { createWorkspaceTools } from "@/tools/workspace-tools"
import { generateRandomId } from "@/common"
import type { ISessionManager } from "@/session/session-manager"
import type { ISessionSnapshot } from "@/domain"


export interface ISnapshotSource<Snapshot> {
    readonly subscribe: (listener: () => void) => () => void
    readonly getSnapshot: () => Snapshot
}

export interface IBuliPromptInput {
    readonly sessionId: string
    readonly text: string
}

// select model and it's effort
export interface IBuliModelSelection {
    readonly modelId: string
    readonly reasoningEffort: TReasoningEffort
}

// bezpieczne dane dla ui i pickerow
export interface IBuliModelInfo {
    readonly id: string
    readonly name: string
    readonly reasoningEfforts: readonly TReasoningEffort[]
}

// register model
// konkretny adapter modelu
export interface IBuliModelRegistration extends IBuliModelInfo {
    readonly model: IAgentModel
}

export interface IBuliApplicationSnapshot {
    readonly models: readonly IBuliModelInfo[]
    readonly selection: IBuliModelSelection
}

export interface IBuliApplicationStartup {
    readonly runtime: BuliApplicationRuntime
    readonly sessionId: string
}

// options for session creation
// nie ma model i reasoning bo sa globalna konfiguracja runtime
// natomiast prompt i narzedzia naleza do konkretnej sesji / agenta
export interface IBuliSessionCreationOptions {
    readonly sessionId: string
    readonly systemPrompt: string
    readonly tools: readonly IAgentTool[]
}

export interface IBuliApplication
extends ISnapshotSource<IBuliApplicationSnapshot> {
    readonly workspaceRoot: string

    readonly selectModel: (modelId: string) => void
    readonly selectReasoningEffort: (
        reasoningEffort: TReasoningEffort,
    ) => void

    readonly submitPrompt: (prompt: IBuliPromptInput) => Promise<void>
    readonly clearSession: (sessionId: string) => void
    readonly abort: (sessionId: string) => void

    readonly getAgentSession: (
        sessionId: string,
    ) => ISnapshotSource<ISessionSnapshot>
    readonly createAgentSession: (
        options: IBuliSessionCreationOptions,
    ) => ISnapshotSource<ISessionSnapshot>
}

interface IBuliRuntimeOptions {
    readonly workspaceRoot: string
    readonly manager: ISessionManager
    // readonly tuiControler: ITuiController
    readonly models: readonly IBuliModelRegistration[]
    readonly selection: IBuliModelSelection
}

type TBuliRuntimeListener = () => void
type TBuliRuntimeSubscribe = () => void

/** Owns and reuses one AgentSession for each requested session ID. */
export class BuliApplicationRuntime implements IBuliApplication {
    // working area
    readonly workspaceRoot: string
    private readonly manager: ISessionManager
    private readonly models: readonly IBuliModelRegistration[]
    private selection: IBuliModelSelection
    // What are agent sesions what is thier responsibility
    private readonly sessions = new Map<string, AgentSession>()
    // what does it mean ?
    private disposed = false

    private readonly listeners = new Set<TBuliRuntimeListener>()
    private snapshot: IBuliApplicationSnapshot

    constructor(options: IBuliRuntimeOptions) {
        this.workspaceRoot = options.workspaceRoot
        this.manager = options.manager
        this.models = options.models.map((registration) => ({
            ...registration,
            reasoningEfforts: [...registration.reasoningEfforts],
        }))
        this.selection = { ...options.selection }

        this.resolveSelectedModel()
        this.snapshot = this.createSnapshot()
    }

    readonly createAgentSession = (options: IBuliSessionCreationOptions): ISnapshotSource<ISessionSnapshot> => {
        if (this.disposed) throw new Error("Buli runtime is disposed")

        if (this.sessions.has(options.sessionId)) throw new Error(`Agent session already exists: ${options.sessionId}`)

        const session = new AgentSession({
            sessionId: options.sessionId,
            manager: this.manager,
            systemPrompt: options.systemPrompt,
            resolveRunConfiguration: () => {
                const registration = this.resolveSelectedModel()

                return {
                    model: registration.model,
                    reasoningEffort: this.selection.reasoningEffort,
                }
            },
            tools: options.tools,
        })

        this.sessions.set(options.sessionId, session)
        return session
    }


    readonly submitPrompt = async (prompt: IBuliPromptInput): Promise<void> => {
        if (this.disposed) throw new Error("Buli runtime is disposed")

        await this.requireAgentSession(prompt.sessionId).prompt(prompt.text)
    }

    readonly clearSession = (sessionId: string): void => {
        if (this.disposed) throw new Error("Buli runtime is disposed")
        this.requireAgentSession(sessionId).clear()
    }

    readonly getAgentSession = (
        sessionId: string,
    ): ISnapshotSource<ISessionSnapshot> => {
        if (this.disposed) throw new Error("Buli runtime is disposed")
        return this.requireAgentSession(sessionId)
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


    readonly abort = (sessionId: string): void => {
        if (this.disposed) throw new Error("Buli runtime is disposed")
        this.sessions.get(sessionId)?.abort()
    }

    readonly dispose = (): void => {
        if (this.disposed) return
        this.disposed = true

        for (const session of this.sessions.values()) session.dispose()
        this.sessions.clear()
        this.listeners.clear()
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
        const models = this.models.map((registration: IBuliModelRegistration) => Object.freeze({
            id: registration.id,
            name: registration.name,
            reasoningEfforts: Object.freeze([
                ...registration.reasoningEfforts,
            ]),
        }))

        return Object.freeze({
            models: Object.freeze(models),
            selection: Object.freeze({ ...this.selection }),
        })
    }

    private requireAgentSession(sessionId: string): AgentSession {
        const session: AgentSession | undefined = this.sessions.get(sessionId)
        if (!session) throw new Error(`Agent session does not exist: ${sessionId}`)

        return session
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

interface IBuliApplicationOptions {
    readonly signal: AbortSignal
    readonly manager?: ISessionManager
    readonly model?: IAgentModel
    readonly tools?: readonly IAgentTool[]
}

/** Composes provider, tools, persistence, sessions, and the UI boundary. */
export async function createBuliApplication(
    options: IBuliApplicationOptions,
): Promise<IBuliApplicationStartup> {
    // ?? totalnie nie rozumiem dlaczego 2x wywolujemy throwIfAborted i po co
    // To dwa checkpointy po obu stronach operacji asynchronicznej. Pierwszy kończy
    // start od razu, jeśli sygnał był już anulowany, więc nie uruchamiamy `realpath`.
    // Podczas `await realpath(...)` sterowanie wraca do event loopa i właśnie wtedy
    // może nastąpić abort; samo `realpath` nie przyjmuje tutaj sygnału i go nie wykryje.
    // Drugie sprawdzenie wychwytuje taki abort i nie pozwala tworzyć managera, modelu,
    // runtime ani sesji. Bez abort oba wywołania nic nie robią, a po nim rzucają
    // `signal.reason`, przez co Promise zwracany przez tę funkcję zostaje odrzucony.
    options.signal.throwIfAborted()
    const workspaceRoot = await realpath(process.cwd())
    options.signal.throwIfAborted()

    const manager: ISessionManager = options.manager ?? new JsonlSessionManager({
        filePath: defaultSessionFilePath(workspaceRoot),
    })
    const model: IAgentModel = options.model ?? new OpenAiAgentModel()
    const models: readonly IBuliModelRegistration[] = [{
        id: DEFAULT_OPENAI_MODEL_ID,
        name: "GPT-5.6 Sol",
        model,
        reasoningEfforts: [
            "none",
            "low",
            "medium",
            "high",
            "xhigh",
            "max",
        ],
    }]
    const selection: IBuliModelSelection = {
        modelId: DEFAULT_OPENAI_MODEL_ID,
        reasoningEffort: "medium",
    }
    const tools: readonly IAgentTool[] = options.tools ?? createWorkspaceTools(workspaceRoot)

    const agentSystemPrompt: string = systemPrompt(workspaceRoot)
    const sessionId: string = generateRandomId()

    const runtime = new BuliApplicationRuntime({
        workspaceRoot,
        manager,
        models,
        selection,
    })

    runtime.createAgentSession({
        sessionId,
        systemPrompt: agentSystemPrompt,
        tools,
    })

    options.signal.addEventListener("abort", runtime.dispose, { once: true })
    return { runtime, sessionId }
}
