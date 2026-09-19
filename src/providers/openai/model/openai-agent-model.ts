import { createOpenAI } from "@ai-sdk/openai"
import {
    APICallError,
    type AssistantContent,
    type ModelMessage,
    type ToolContent,
    type UserContent,
} from "ai"

import type {
    TAgentMessage,
    IAgentModel,
    TAgentModelEvent,
    IAgentModelRequest,
} from "@/agent"
import {
    isModelContextOverflowError,
    ModelContextOverflowError,
} from "@/agent"
import {
    DEFAULT_OPENAI_MODEL_ID,
    OPENAI_CODEX_BASE_URL,
    OPENAI_CODEX_RESPONSES_URL,
    OPENAI_OAUTH_DUMMY_API_KEY,
} from "@/providers/openai/constants"

import { streamAiSdkTurn } from "@/providers/shared/ai-sdk-agent-model"

export { DEFAULT_OPENAI_MODEL_ID } from "@/providers/openai/constants"

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
    /** Known capability; otherwise use the built-in default's capability or SDK inference. */
    readonly supportsReasoning?: boolean
}

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
    private readonly supportsReasoning: boolean | undefined

    constructor(options: IOpenAiAgentModelOptions) {
        this.auth = options.auth
        this.modelId = options.modelId ?? DEFAULT_OPENAI_MODEL_ID
        this.expectedAccountId = options.expectedAccountId
        this.serviceTier = options.serviceTier
        // The installed SDK's older model-ID heuristics do not recognize Astra.
        // Trust explicit capability metadata or this verified built-in model,
        // never a blanket GPT-6 prefix; unknown IDs keep the SDK's own inference.
        this.supportsReasoning = options.supportsReasoning
            ?? (this.modelId === DEFAULT_OPENAI_MODEL_ID ? true : undefined)
    }

    async *stream(
        request: IAgentModelRequest,
    ): AsyncIterable<TAgentModelEvent> {
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
        yield* streamAiSdkTurn(request, {
            model: provider.responses(this.modelId),
            messages: toModelMessages(
                request.messages,
                request.contextSummary,
            ),
            providerOptions: {
                openai: {
                    store: false,
                    instructions: request.systemPrompt,
                    // TODO: Verify with a live gpt-6-astra request that one response can
                    // contain multiple local calls. Buli intentionally executes that
                    // returned batch sequentially; benchmark before adding concurrency.
                    ...(request.tools.length === 0
                        ? {}
                        : { parallelToolCalls: true }),
                    reasoningEffort: request.reasoningEffort,
                    ...(this.supportsReasoning === undefined
                        ? {}
                        : { forceReasoning: this.supportsReasoning }),
                    ...(request.reasoningEffort === "none"
                        ? {}
                        : { reasoningSummary: "detailed" as const }),
                },
            },
            toolCallReasoning: { mode: "not-required" },
            normalizeError: normalizeOpenAiModelError,
        })
    }
}

/**
 * The older SDK drops priority for IDs outside its static model allowlist.
 * Inject the account-authorized tier after serialization, only for the Codex
 * Responses POST. Fast keeps the base wire model ID, never Buli's ::fast ID.
 */
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
        content: `Cumulative operational checkpoint:\n${contextSummary}`,
    }, ...projected]
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
