import { createOpenAI } from "@ai-sdk/openai"
import {
    isStepCount,
    jsonSchema,
    streamText,
    tool,
    type AssistantContent,
    type JSONSchema7,
    type ModelMessage,
    type ToolContent,
    type ToolSet,
} from "ai"

import type {
    IAgentModel,
    IAgentModelEvent,
    IAgentModelRequest,
    IAgentToolDescriptor,
    IModelUsage,
    TAgentMessage,
} from "@/agent"
import {
    OPENAI_CODEX_BASE_URL,
    OPENAI_OAUTH_DUMMY_API_KEY,
} from "@/providers/openai/constants"

export const DEFAULT_OPENAI_MODEL_ID = "gpt-5.6-sol"

/** Narrow authentication transport required by the OpenAI model adapter. */
export interface IOpenAiModelTransport {
    readonly authenticatedFetch: typeof fetch
    readonly authenticatedFetchForAccount?: (
        accountId: string,
    ) => typeof fetch
    readonly requireCredential: (
        signal?: AbortSignal,
    ) => Promise<{ readonly accountId?: string }>
}

export interface IOpenAiAgentModelOptions {
    // The model borrows this transport and never owns authentication resources.
    readonly auth: IOpenAiModelTransport
    readonly modelId?: string
    readonly expectedAccountId?: string
}

// ?? please explain me this types line by line how it works
// `typeof streamText<ToolSet>` pobiera typ funkcji `streamText` po podstawieniu
// generycznego typu narzędzi `ToolSet`; nie wywołuje funkcji w runtime.
// `ReturnType<...>` wyciąga typ wartości zwracanej przez tę funkcję.
// `["stream"]` jest indexed-access type i wybiera typ pola `stream` z wyniku.
// `extends AsyncIterable<infer Event>` sprawdza, czy stream jest iterowalny
// asynchronicznie, a `infer Event` wyciąga typ jednego emitowanego elementu.
// Jeśli warunek pasuje, wynikiem jest `Event`, w przeciwnym razie `never`.
// Ostatecznie `AIStreamEvent` oznacza unię pojedynczych eventów streamu AI SDK.
type AIStreamEvent = ReturnType<typeof streamText<ToolSet>>["stream"] extends
    AsyncIterable<infer Event> ? Event : never
// ?? this also
// `AssistantContent` jest unią: zwykły `string` albo tablica części wiadomości.
// `Exclude<AssistantContent, string>` usuwa z tej unii wariant `string`, więc
// pozostaje tablica. Dostęp `[number]` pobiera typ dowolnego elementu tablicy.
// `AIAssistantPart` oznacza zatem jedną część wiadomości, np. tekst lub tool call,
// a nie całą wiadomość ani całą tablicę. To również działa tylko na poziomie typów.
type AIAssistantPart = Exclude<AssistantContent, string>[number]

/** Translates one Buli model turn to and from the OpenAI AI SDK protocol. */
export class OpenAiAgentModel implements IAgentModel {
    private readonly auth: IOpenAiModelTransport
    private readonly modelId: string
    private readonly expectedAccountId: string | undefined

    constructor(options: IOpenAiAgentModelOptions) {
        this.auth = options.auth
        this.modelId = options.modelId ?? DEFAULT_OPENAI_MODEL_ID
        this.expectedAccountId = options.expectedAccountId
    }

    async *stream(
        request: IAgentModelRequest,
    ): AsyncIterable<IAgentModelEvent> {
        request.signal.throwIfAborted()
        const credential = await this.auth.requireCredential(request.signal)
        if (
            this.expectedAccountId
            && credential.accountId !== this.expectedAccountId
        ) {
            throw new Error(
                "OpenAI account changed; run `/model` to refresh available models",
            )
        }
        request.signal.throwIfAborted()
        const requestAccountId = this.expectedAccountId
            ?? credential.accountId?.trim()
        if (requestAccountId) {
            request.reportProviderAccountId?.(requestAccountId)
        }
        const authenticatedFetch = requestAccountId
            && this.auth.authenticatedFetchForAccount
            ? this.auth.authenticatedFetchForAccount(requestAccountId)
            : this.auth.authenticatedFetch

        const provider = createOpenAI({
            baseURL: OPENAI_CODEX_BASE_URL,
            apiKey: OPENAI_OAUTH_DUMMY_API_KEY,
            fetch: authenticatedFetch,
        })
        const result = streamText({
            model: provider.responses(this.modelId),
            messages: toModelMessages(
                request.messages,
                request.contextSummary,
            ),
            tools: toAiTools(request.tools),
            abortSignal: request.signal,
            providerOptions: {
                openai: {
                    store: false,
                    instructions: request.systemPrompt,
                    // TODO: Verify with a live gpt-5.6-sol request that one response can
                    // contain multiple local calls. Buli intentionally executes that
                    // returned batch sequentially; benchmark before adding concurrency.
                    parallelToolCalls: true,
                    reasoningEffort: request.reasoningEffort,
                },
            },
            stopWhen: isStepCount(1),
            maxRetries: 0,
            ...(request.maxOutputTokens === undefined
                ? {}
                : { maxOutputTokens: request.maxOutputTokens }),
        })

        for await (const event of result.stream) {
            const modelEvent = toAgentModelEvent(event)
            if (modelEvent) yield modelEvent
        }
    }
}

function toAiTools(
    descriptors: readonly IAgentToolDescriptor[],
): ToolSet {
    return Object.fromEntries(descriptors.map((descriptor) => [
        descriptor.name,
        tool({
            description: descriptor.description,
            inputSchema: jsonSchema<Record<string, unknown>>(
                descriptor.inputSchema as JSONSchema7,
            ),
            outputSchema: jsonSchema<string>({ type: "string" }),
        }),
    ])) as ToolSet
}

function toModelMessages(
    messages: readonly TAgentMessage[],
    contextSummary?: string,
): ModelMessage[] {
    const projected = messages.flatMap((message): ModelMessage[] => {
        switch (message.role) {
            case "user":
                return [{ role: "user", content: message.content }]
            case "assistant": {
                if (message.stopReason === "error" || message.stopReason === "aborted") {
                    return []
                }

                const content: Exclude<AssistantContent, string> = message.content.flatMap(
                    (item): AIAssistantPart[] => {
                        switch (item.type) {
                            case "text":
                                return [{ type: "text", text: item.text }]
                            case "reasoning":
                                return []
                            case "toolCall":
                                return [{
                                    type: "tool-call" as const,
                                    toolCallId: item.toolCallId,
                                    toolName: item.toolName,
                                    input: structuredClone(item.input),
                                }]
                        }
                    },
                )
                return content.length > 0 ? [{ role: "assistant", content }] : []
            }
            case "toolResult": {
                const content: ToolContent = [{
                    type: "tool-result",
                    toolCallId: message.toolCallId,
                    toolName: message.toolName,
                    output: message.isError
                        ? { type: "error-text", value: message.content }
                        : { type: "text", value: message.content },
                }]
                return [{ role: "tool", content }]
            }
        }
    })
    if (!contextSummary) return projected

    // Responses adapter nie zezwala na `system` w messages (instrukcje przekazuje
    // osobno). `assistant` oznacza więc wcześniejszy stan rozmowy, nie nowy prompt.
    return [{
        role: "assistant",
        content: `Conversation summary before the retained transcript:\n${contextSummary}`,
    }, ...projected]
}

function toAgentModelEvent(
    event: AIStreamEvent,
): IAgentModelEvent | undefined {
    switch (event.type) {
        case "text-start":
            return { type: "text-start", id: event.id }
        case "text-delta":
            return { type: "text-delta", id: event.id, delta: event.text }
        case "text-end":
            return { type: "text-end", id: event.id }
        case "reasoning-start":
            return { type: "reasoning-start", id: event.id }
        case "reasoning-delta":
            return { type: "reasoning-delta", id: event.id, delta: event.text }
        case "reasoning-end":
            return { type: "reasoning-end", id: event.id }
        case "tool-call":
            return {
                type: "tool-call",
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                input: toRecord(event.input),
            }
        case "finish": {
            const usage = toModelUsage(event.totalUsage)
            return {
                type: "finish",
                reason: event.rawFinishReason ?? event.finishReason,
                ...(usage === undefined ? {} : { usage }),
            }
        }
        case "abort":
            return {
                type: "abort",
                ...(event.reason ? { reason: event.reason } : {}),
            }
        case "error":
            return { type: "error", error: event.error }
        default:
            return undefined
    }
}

function toModelUsage(usage: {
    readonly inputTokens?: number | undefined
    readonly outputTokens?: number | undefined
    readonly totalTokens?: number | undefined
    readonly cachedInputTokens?: number | undefined
    readonly reasoningTokens?: number | undefined
}): IModelUsage | undefined {
    const result: IModelUsage = {
        ...(usage.inputTokens === undefined
            ? {}
            : { inputTokens: usage.inputTokens }),
        ...(usage.outputTokens === undefined
            ? {}
            : { outputTokens: usage.outputTokens }),
        ...(usage.totalTokens === undefined
            ? {}
            : { totalTokens: usage.totalTokens }),
        ...(usage.cachedInputTokens === undefined
            ? {}
            : { cacheReadTokens: usage.cachedInputTokens }),
        ...(usage.reasoningTokens === undefined
            ? {}
            : { reasoningTokens: usage.reasoningTokens }),
    }
    return Object.keys(result).length === 0 ? undefined : result
}

function toRecord(value: unknown): Record<string, unknown> {
    if (value === null || Array.isArray(value) || typeof value !== "object") {
        throw new TypeError("Tool input must be an object")
    }
    return structuredClone(value as Record<string, unknown>)
}
