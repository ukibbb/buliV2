import { createOpenAI } from "@ai-sdk/openai"
import {
    APICallError,
    isStepCount,
    jsonSchema,
    streamText,
    tool,
    type AssistantContent,
    type JSONSchema7,
    type LanguageModelUsage,
    type ModelMessage,
    type ToolContent,
    type ToolSet,
    type UserContent,
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
    isModelContextOverflowError,
    ModelContextOverflowError,
} from "@/agent"
import {
    OPENAI_CODEX_BASE_URL,
    OPENAI_CODEX_RESPONSES_URL,
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
    readonly serviceTier?: "priority"
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
    private readonly serviceTier: "priority" | undefined

    constructor(options: IOpenAiAgentModelOptions) {
        this.auth = options.auth
        this.modelId = options.modelId ?? DEFAULT_OPENAI_MODEL_ID
        this.expectedAccountId = options.expectedAccountId
        this.serviceTier = options.serviceTier
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
        const modelFetch = this.serviceTier === undefined
            ? authenticatedFetch
            : withServiceTier(authenticatedFetch, this.serviceTier)

        const provider = createOpenAI({
            baseURL: OPENAI_CODEX_BASE_URL,
            apiKey: OPENAI_OAUTH_DUMMY_API_KEY,
            fetch: modelFetch,
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
                    ...(request.tools.length === 0
                        ? {}
                        : { parallelToolCalls: true }),
                    reasoningEffort: request.reasoningEffort,
                    ...(request.reasoningEffort === "none"
                        ? {}
                        : { reasoningSummary: "detailed" as const }),
                },
            },
            stopWhen: isStepCount(1),
            maxRetries: 0,
            // Errors are normalized below and surfaced through Buli's stream.
            onError: () => { },
            ...(request.maxOutputTokens === undefined
                ? {}
                : { maxOutputTokens: request.maxOutputTokens }),
        })

        try {
            for await (const event of result.stream) {
                const modelEvent = toAgentModelEvent(event)
                if (modelEvent) yield modelEvent
            }
        } catch (error) {
            throw normalizeOpenAiModelError(error)
        }
    }
}

/** Applies account-authorized tiers after the SDK's static model allowlist. */
function withServiceTier(
    fetcher: typeof fetch,
    serviceTier: "priority",
): typeof fetch {
    const run = async (
        input: RequestInfo | URL,
        init?: RequestInit,
    ): Promise<Response> => {
        const request = new Request(input, init)
        if (
            request.url !== OPENAI_CODEX_RESPONSES_URL
            || request.method !== "POST"
        ) {
            return fetcher(input, init)
        }

        const body: unknown = await request.json()
        if (!isRecord(body)) {
            throw new Error("OpenAI Responses request body must be a JSON object")
        }
        const headers = new Headers(request.headers)
        headers.delete("content-length")
        return fetcher(new Request(request, {
            headers,
            body: JSON.stringify({ ...body, service_tier: serviceTier }),
        }))
    }
    return Object.assign(run, { preconnect: fetcher.preconnect })
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
                if (!message.attachments?.length) {
                    return [{ role: "user", content: message.content }]
                }
                return [{
                    role: "user",
                    content: [
                        { type: "text", text: message.content },
                        ...message.attachments.map((attachment) => ({
                            type: "file" as const,
                            data: attachment.data,
                            mediaType: attachment.mimeType,
                            filename: attachment.filename,
                        })),
                    ] satisfies UserContent,
                }]
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
            return { type: "error", error: normalizeOpenAiModelError(event.error) }
        default:
            return undefined
    }
}

function toModelUsage(usage: LanguageModelUsage): IModelUsage | undefined {
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
        ...(!usage.inputTokenDetails.cacheReadTokens
            ? {}
            : { cacheReadTokens: usage.inputTokenDetails.cacheReadTokens }),
        ...(!usage.inputTokenDetails.cacheWriteTokens
            ? {}
            : { cacheWriteTokens: usage.inputTokenDetails.cacheWriteTokens }),
        ...(!usage.outputTokenDetails.reasoningTokens
            ? {}
            : { reasoningTokens: usage.outputTokenDetails.reasoningTokens }),
    }
    return Object.keys(result).length === 0 ? undefined : result
}

function normalizeOpenAiModelError(error: unknown): unknown {
    if (isModelContextOverflowError(error)) return error
    if (isOpenAiContextOverflow(error)) {
        return new ModelContextOverflowError(openAiErrorMessage(error), {
            cause: error,
        })
    }
    if (!APICallError.isInstance(error)) return error
    return new Error(openAiErrorMessage(error), { cause: error })
}

function isOpenAiContextOverflow(error: unknown): boolean {
    const statusCode = APICallError.isInstance(error)
        ? error.statusCode
        : isRecord(error) && typeof error.statusCode === "number"
            ? error.statusCode
            : undefined
    if (statusCode === 413) return true
    if (statusCode !== 400) return false

    const searchable = [
        error instanceof Error ? error.message : undefined,
        APICallError.isInstance(error) ? error.responseBody : undefined,
        APICallError.isInstance(error) ? safeJson(error.data) : undefined,
    ].filter((value): value is string => Boolean(value)).join(" ").toLowerCase()
    return CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(searchable))
}

const CONTEXT_OVERFLOW_PATTERNS = [
    /context[_ ]length[_ ]exceeded/,
    /model_context_window_exceeded/,
    /maximum context length/,
    /exceeds the context window/,
    /input is too long for requested model/,
    /prompt is too long/,
    /too many tokens/,
]

function openAiErrorMessage(error: unknown): string {
    if (!APICallError.isInstance(error)) {
        return error instanceof Error
            ? error.message
            : "OpenAI model request failed"
    }
    const status = error.statusCode === undefined ? "" : ` (${error.statusCode})`
    const detail = nestedErrorMessage(error.data)
        ?? error.responseBody?.trim()
        ?? error.message
    const requestId = error.responseHeaders?.["x-request-id"]
        ?? error.responseHeaders?.["request-id"]
        ?? error.responseHeaders?.["openai-request-id"]
    const message = `OpenAI request failed${status}: ${detail}`
        + (requestId ? ` [request ${requestId}]` : "")
    return truncateErrorMessage(message, 2_000)
}

function nestedErrorMessage(value: unknown): string | undefined {
    if (!isRecord(value)) return undefined
    if (typeof value.message === "string" && value.message.trim()) {
        return value.message.trim()
    }
    return nestedErrorMessage(value.error)
}

function truncateErrorMessage(value: string, maximumCharacters: number): string {
    const characters = [...value]
    if (characters.length <= maximumCharacters) return value
    return `${characters.slice(0, maximumCharacters - 3).join("")}...`
}

function safeJson(value: unknown): string | undefined {
    if (value === undefined) return undefined
    try {
        return JSON.stringify(value)
    } catch {
        return undefined
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function toRecord(value: unknown): Record<string, unknown> {
    if (value === null || Array.isArray(value) || typeof value !== "object") {
        throw new TypeError("Tool input must be an object")
    }
    return structuredClone(value as Record<string, unknown>)
}
