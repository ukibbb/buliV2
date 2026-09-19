import type {
    TReasoningEffort,
    IUserInputContent,
} from "@/agent"
import type {
    ICompactionCheckpoint,
    ISessionInfo,
    ISessionSnapshot,
} from "@/sessions"

export interface ISnapshotSource<Snapshot> {
    readonly subscribe: (listener: () => void) => () => void
    readonly getSnapshot: () => Snapshot
}

export interface IBuliPromptInput extends IUserInputContent {
    readonly sessionId?: string
}

export interface IBuliPathSuggestion {
    readonly kind: "file" | "directory"
    readonly path: string
    readonly displayPath: string
}

export type TBuliPathSearcher = (
    query: string,
    signal: AbortSignal,
) => Promise<readonly IBuliPathSuggestion[]>

export interface IBuliPromptRun {
    readonly sessionId: string
    readonly runId: string
    readonly promptPersisted: Promise<void>
    readonly runFinished: Promise<void>
}

export interface IBuliQueuedMessages {
    readonly steering: readonly (string | IUserInputContent)[]
    readonly followUp: readonly (string | IUserInputContent)[]
}

export interface IBuliAgentDisplayInfo {
    readonly id: string
    readonly name: string
}

// select model and it's effort
export interface IBuliModelSelection {
    readonly modelId: string
    readonly reasoningEffort: TReasoningEffort
}

// bezpieczne dane dla ui i pickerow
export interface IBuliModelDisplayInfo {
    readonly id: string
    readonly name: string
    readonly reasoningEfforts: readonly TReasoningEffort[]
}

export interface IBuliProviderCatalogStatus {
    readonly providerId: string
    readonly status: "ready" | "disconnected" | "error"
    readonly stale: boolean
    readonly message?: string
}

export interface IBuliApplicationSnapshot {
    readonly agents: readonly IBuliAgentDisplayInfo[]
    readonly defaultAgentId: string
    readonly models: readonly IBuliModelDisplayInfo[]
    readonly selection: IBuliModelSelection
    readonly providerCatalogs?: readonly IBuliProviderCatalogStatus[]
    readonly selectedModelAvailable?: boolean
    // Present only when initial catalog discovery is required. Loading/error
    // hides provisional models and blocks generation; a ready message is advisory.
    // Until ready, selection may reference a provisional ID absent from models.
    readonly modelCatalog?: {
        readonly status: "loading" | "ready" | "error"
        readonly message?: string
    }
}

// Resolve fixed prompt and tools from the registered agent when creating a session.
export interface IBuliSessionCreationOptions {
    readonly agentId: string
    readonly title: string
}

export interface IBuliApplication
    extends ISnapshotSource<IBuliApplicationSnapshot> {
    readonly workspaceRoot: string

    readonly refreshModels: (signal?: AbortSignal) => Promise<void>
    readonly selectModel: (modelId: string) => void
    readonly selectReasoningEffort: (
        reasoningEffort: TReasoningEffort,
    ) => void

    readonly submitPrompt: (prompt: IBuliPromptInput) => IBuliPromptRun
    readonly steer: (
        sessionId: string,
        text: string,
        resources?: Omit<IUserInputContent, "text">,
    ) => void
    readonly followUp: (
        sessionId: string,
        text: string,
        resources?: Omit<IUserInputContent, "text">,
    ) => void
    readonly clearQueuedMessages: (sessionId: string) => IBuliQueuedMessages
    readonly searchPaths?: (
        query: string,
        signal?: AbortSignal,
    ) => Promise<readonly IBuliPathSuggestion[]>
    readonly compactSession: (
        sessionId: string,
    ) => Promise<ICompactionCheckpoint | undefined>
    readonly abort: (sessionId: string) => Promise<void>
    readonly dispose: () => Promise<void>

    readonly createSession: (
        options: IBuliSessionCreationOptions,
    ) => ISessionInfo
    readonly openSession: (
        sessionId: string,
    ) => ISnapshotSource<ISessionSnapshot>
    readonly closeSession: (sessionId: string) => Promise<void>
    readonly listSessions: () => readonly ISessionInfo[]
}
