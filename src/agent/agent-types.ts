import type {
    IAssistantMessage,
    IModelProfile,
    IModelUsage,
    IToolResultMessage,
    TAgentMessage,
    TAgentRunEndReason,
    TToolApprovalDecision,
    TToolApprovalDraft,
    TToolApprovalRequest,
    TToolExecutionOutcome,
} from "@/domain"



export type TReasoningEffort =
    | "none"
    | "minimal"
    | "low"
    | "medium"
    | "high"
    | "xhigh"
    | "max"

// ?? Co to jest tool descriptor moze byc IAgentToolDefinition?
// To pozbawiony kodu wykonawczego opis narzędzia przekazywany modelowi: jego nazwa,
// przeznaczenie i JSON Schema wejścia. `IAgentTool` rozszerza ten descriptor o
// lokalną funkcję `execute`, której model nie dostaje. Nazwa `IAgentToolDefinition`
// też byłaby poprawna, jeśli oznaczałaby w projekcie specyfikację dla modelu;
// `Descriptor` wyraźniej podkreśla, że ten obiekt tylko opisuje implementację.
export interface IAgentToolDescriptor {
    readonly name: string
    readonly description: string
    readonly inputSchema: Record<string, unknown>
}

// ?? co to jest ?
// To dane pomocnicze dotyczące jednego wykonania narzędzia, przekazywane osobno od
// `input` wygenerowanego przez model. `toolCallId` łączy wykonanie i jego wynik z
// konkretnym tool callem, a `signal` pozwala narzędziu reagować na anulowanie całego
// bieżącego runu. Pętla agenta tworzy ten obiekt tuż przed wywołaniem `execute`.
export interface IAgentToolExecutionContext {
    readonly toolCallId: string
    readonly runId: string
    readonly signal: AbortSignal
    // Postęp jest przejściowym snapshotem dla UI. Nie trafia do trwałej historii;
    // tylko finalny wynik narzędzia staje się wiadomością `toolResult`.
    readonly reportProgress?: (progress: string) => void
    readonly requestApproval?: (
        draft: TToolApprovalDraft,
    ) => Promise<TToolApprovalDecision>
}

export interface IAgentToolExecutionResult {
    readonly content: string
    readonly outcome?: TToolExecutionOutcome
    readonly summary?: string
}

export interface IAgentTool extends IAgentToolDescriptor {
    readonly execute: (
        input: Record<string, unknown>,
        context: IAgentToolExecutionContext,
    ) => Promise<string | IAgentToolExecutionResult>
}

// ?? co to jest?
// To niezależny od providera komplet danych dla jednego wywołania `model.stream`.
// Jeden prompt może utworzyć kilka takich requestów, gdy model wywołuje narzędzia.
// `sessionId` identyfikuje sesję, `systemPrompt` zawiera instrukcje, a `messages`
// jest snapshotem zachowanego ogona tej iteracji. Opcjonalne `contextSummary`
// zastępuje starszy prefix po kompaktowaniu. `tools` zawiera tylko opisy narzędzi,
// `signal` służy do anulowania, a `reasoningEffort` wybiera poziom rozumowania.
// `readonly` blokuje przypisanie w TypeScript, ale nie zamraża obiektu w runtime
// ani nie zatrzymuje zmiany stanu `AbortSignal`.
export interface IAgentModelRequest {
    readonly sessionId: string
    readonly runId: string
    readonly systemPrompt: string
    readonly contextSummary?: string
    readonly messages: readonly TAgentMessage[]
    readonly tools: readonly IAgentToolDescriptor[]
    readonly signal: AbortSignal
    readonly reasoningEffort: TReasoningEffort
    readonly maxOutputTokens?: number
}

export interface IAgentContextProjection {
    readonly messages: readonly TAgentMessage[]
    readonly contextSummary?: string
}

export type TAgentContextProjector = (
    messages: readonly TAgentMessage[],
) => IAgentContextProjection

export type IAgentModelEvent =
    | { readonly type: "text-start"; readonly id: string }
    | { readonly type: "text-delta"; readonly id: string; readonly delta: string }
    | { readonly type: "text-end"; readonly id: string }
    | { readonly type: "reasoning-start"; readonly id: string }
    | {
        readonly type: "reasoning-delta"
        readonly id: string
        readonly delta: string
    }
    | { readonly type: "reasoning-end"; readonly id: string }
    | {
        readonly type: "tool-call"
        readonly toolCallId: string
        readonly toolName: string
        readonly input: Record<string, unknown>
    }
    | {
        readonly type: "finish"
        readonly reason: string
        readonly usage?: IModelUsage
    }
    | { readonly type: "abort"; readonly reason?: string }
    | { readonly type: "error"; readonly error: unknown }

export interface IAgentModel {
    readonly stream: (
        request: IAgentModelRequest,
    ) => AsyncIterable<IAgentModelEvent>
}

export interface IAgentRunConfiguration {
    readonly model: IAgentModel
    readonly modelProfile?: IModelProfile
    readonly reasoningEffort: TReasoningEffort
}

export type TAgentRunConfigurationResolver = () => IAgentRunConfiguration

export type { TAgentRunEndReason } from "@/domain"

interface IAgentEventBase {
    readonly runId: string
}

type TAgentEventPayload =
    | { readonly type: "agent_start" }
    | {
        readonly type: "agent_end"
        readonly reason: TAgentRunEndReason
        readonly messages: readonly TAgentMessage[]
    }
    | { readonly type: "turn_start"; readonly index: number }
    | {
        readonly type: "turn_end"
        readonly index: number
        readonly message: IAssistantMessage
        readonly toolResults: readonly IToolResultMessage[]
        readonly willContinue: boolean
    }
    | { readonly type: "message_start"; readonly message: TAgentMessage }
    | {
        readonly type: "message_update"
        readonly message: IAssistantMessage
        readonly modelEvent: IAgentModelEvent
    }
    | { readonly type: "message_end"; readonly message: TAgentMessage }
    | {
        readonly type: "tool_execution_start"
        readonly toolCallId: string
        readonly toolName: string
        readonly input: Record<string, unknown>
    }
    | {
        readonly type: "tool_execution_update"
        readonly toolCallId: string
        readonly toolName: string
        readonly progress: string
    }
    | {
        readonly type: "tool_execution_end"
        readonly toolCallId: string
        readonly toolName: string
        readonly result: IToolResultMessage
    }
    | {
        readonly type: "tool_approval_requested"
        readonly request: TToolApprovalRequest
    }
    | {
        readonly type: "tool_approval_resolved"
        readonly approvalId: string
        readonly decision: TToolApprovalDecision | undefined
    }
    | {
        readonly type: "agent_settled"
        readonly reason: TAgentRunEndReason
        readonly errorMessage?: string
    }

export type IAgentEvent = IAgentEventBase & TAgentEventPayload

export interface IAgentState {
    readonly sessionId: string
    readonly systemPrompt: string
    readonly tools: readonly IAgentTool[]
    readonly messages: readonly TAgentMessage[]
    readonly isRunning: boolean
    readonly activeRunId: string | undefined
    readonly streamingMessage: IAssistantMessage | undefined
    readonly pendingToolCallIds: ReadonlySet<string>
    readonly pendingToolApproval: TToolApprovalRequest | undefined
    readonly errorMessage: string | undefined
    readonly lastRunReason: TAgentRunEndReason | undefined
}

export type TAgentEventListener = (
    event: IAgentEvent,
    signal: AbortSignal,
) => void | Promise<void>

export type TAgentCriticalEventSink = (
    event: IAgentEvent,
    signal: AbortSignal,
) => void | Promise<void>

export interface IAgentRunHandle {
    readonly runId: string
    readonly accepted: Promise<void>
    readonly settled: Promise<void>
}

export interface IAgentLoopResult {
    readonly reason: TAgentRunEndReason
    readonly messages: readonly TAgentMessage[]
}

export type {
    TToolApprovalDecision,
    TToolApprovalDraft,
    TToolApprovalRequest,
    TToolExecutionOutcome,
} from "@/domain"
