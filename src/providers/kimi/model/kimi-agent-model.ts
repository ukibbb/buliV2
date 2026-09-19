import { createMoonshotAI } from "@ai-sdk/moonshotai"
import { APICallError } from "ai"
import type { IAgentModel, IAgentModelRequest, TAgentModelEvent } from "@/agent"
import { streamAiSdkTurn } from "@/providers/shared/ai-sdk-agent-model"
import { toKimiModelMessages } from "./kimi-model-messages"

export type TKimiModelId = "k3" | "k3-256k" | "kimi-for-coding"
export interface IKimiAgentModelOptions {
    readonly auth: { readonly authenticatedFetch: typeof fetch }
    readonly modelId: TKimiModelId
}

export class KimiAgentModel implements IAgentModel {
    constructor(private readonly options: IKimiAgentModelOptions) {
        if (!["k3", "k3-256k", "kimi-for-coding"].includes(options.modelId)) throw new Error("Unsupported Kimi model ID")
    }

    async *stream(request: IAgentModelRequest): AsyncIterable<TAgentModelEvent> {
        request.signal.throwIfAborted()
        const effort = request.reasoningEffort
        if (effort !== "low" && effort !== "high" && effort !== "max") throw new Error("Kimi adapter currently supports only low, high and max reasoning")
        const messages = toKimiModelMessages(request.messages, this.options.modelId, request.contextSummary)
        const provider = createMoonshotAI({
            baseURL: "https://api.kimi.com/coding/v1", apiKey: "buli-transport-owned-auth",
            fetch: this.options.auth.authenticatedFetch,
        })
        yield* streamAiSdkTurn(request, {
            model: provider(this.options.modelId), system: request.systemPrompt, messages,
            providerOptions: { moonshotai: { thinking: { type: "enabled" }, reasoningEffort: effort } },
            toolCallReasoning: {
                mode: "require-nonempty",
                reason: "Kimi returned tool calls without nonempty reasoning; Buli requires replayable tool history; no tools were executed",
            },
            normalizeError: safeError,
        })
    }
}
function safeError(error: unknown): Error {
    const status = APICallError.isInstance(error) ? error.statusCode : undefined
    return new Error(status === undefined
        ? "Kimi model request failed; no automatic retry was performed"
        : `Kimi model request failed (HTTP ${status}); no automatic retry was performed`)
}
