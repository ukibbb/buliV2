import type { AgentMessage } from "@/agent/messages"
import type {
    ModelProfile,
    ModelUsage,
    ReasoningEffort,
} from "@/agent/model-values"
import type { AgentToolDescriptor } from "@/agent/tool"

/** Provider-neutral signal that a model request exceeded its context window. */
export class ModelContextOverflowError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options)
        this.name = "ModelContextOverflowError"
    }
}

export function isModelContextOverflowError(
    value: unknown,
): value is ModelContextOverflowError {
    return value instanceof ModelContextOverflowError
}

/** Complete provider-neutral input for one model stream request. */
export interface AgentModelRequest {
    readonly sessionId: string
    readonly runId: string
    readonly systemPrompt: string
    readonly contextSummary?: string
    readonly messages: readonly AgentMessage[]
    readonly tools: readonly AgentToolDescriptor[]
    readonly signal: AbortSignal
    readonly reasoningEffort: ReasoningEffort
    readonly maxOutputTokens?: number
    readonly reportProviderAccountId?: (accountId: string) => void
}

/** Normalized stream protocol emitted by every model adapter. */
export type AgentModelEvent =
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
        readonly usage?: ModelUsage
    }
    | { readonly type: "abort"; readonly reason?: string }
    | { readonly type: "error"; readonly error: unknown }

/** Provider adapter consumed by the agent run loop. */
export interface AgentModel {
    readonly stream: (
        request: AgentModelRequest,
    ) => AsyncIterable<AgentModelEvent>
}

export interface AgentRunConfiguration {
    readonly model: AgentModel
    readonly modelProfile?: ModelProfile
    readonly providerAccountId?: string
    readonly reasoningEffort: ReasoningEffort
}

export type AgentRunConfigurationResolver = () => AgentRunConfiguration
