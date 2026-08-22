import type { TAgentMessage } from "@/agent/messages"
import type {
    IModelProfile,
    IModelUsage,
    TReasoningEffort,
} from "@/agent/model-values"
import type { IAgentToolDescriptor } from "@/agent/tool"

/** Complete provider-neutral input for one model stream request. */
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

/** Normalized stream protocol emitted by every model adapter. */
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

/** Provider adapter consumed by the agent run loop. */
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
