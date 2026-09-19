import { createDeepSeek } from "@ai-sdk/deepseek"
import { APICallError } from "ai"
import type { IAgentModel, IAgentModelRequest, TAgentModelEvent } from "@/agent"
import { streamAiSdkTurn } from "@/providers/shared/ai-sdk-agent-model"
import { isDeepSeekModelId, type TDeepSeekModelId } from "./deepseek-model-definitions"
import { toDeepSeekModelMessages } from "./deepseek-model-messages"

export interface IDeepSeekAgentModelOptions {
    readonly auth: { readonly authenticatedFetch: typeof fetch }
    readonly modelId: TDeepSeekModelId
}
export class DeepSeekAgentModel implements IAgentModel {
    constructor(private readonly options: IDeepSeekAgentModelOptions) {
        if (!isDeepSeekModelId(options.modelId)) throw new Error("Unsupported DeepSeek model ID")
    }
    async *stream(request: IAgentModelRequest): AsyncIterable<TAgentModelEvent> {
        request.signal.throwIfAborted()
        const effort = request.reasoningEffort
        if (effort !== "low" && effort !== "high" && effort !== "max") throw new Error("DeepSeek adapter currently supports only low, high and max reasoning")
        const messages = toDeepSeekModelMessages(request.messages, this.options.modelId, request.tools.length > 0, request.contextSummary)
        const provider = createDeepSeek({
            baseURL: "https://api.deepseek.com", apiKey: "buli-transport-owned-auth",
            fetch: this.options.auth.authenticatedFetch,
        })
        yield* streamAiSdkTurn(request, {
            model: provider(this.options.modelId), system: request.systemPrompt, messages,
            providerOptions: { deepseek: { thinking: { type: "enabled" }, reasoningEffort: effort } },
            toolCallReasoning: {
                mode: "require-nonempty",
                reason: "DeepSeek returned tool calls without nonempty reasoning; Buli requires replayable tool history; no tools were executed",
            },
            normalizeError: safeError,
        })
    }
}
function safeError(error: unknown): Error {
    const status = APICallError.isInstance(error) ? error.statusCode : undefined
    return new Error(status === undefined
        ? "DeepSeek model request failed; no automatic retry was performed"
        : `DeepSeek model request failed (HTTP ${status}); no automatic retry was performed`)
}
