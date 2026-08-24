import type { IOAuthCredential } from "@/authentication"
import {
    OPENAI_CODEX_CLIENT_VERSION,
    OPENAI_CODEX_MODELS_URL,
    OPENAI_CODEX_RESPONSES_URL,
    OPENAI_CODEX_SEARCH_URL,
    OPENAI_OAUTH_ORIGINATOR,
} from "@/providers/openai/constants"

const SEARCH_MAX_REQUEST_BYTES = 128 * 1024
const SEARCH_MAX_RESPONSE_BYTES = 2 * 1024 * 1024

const STRIPPED_HEADERS = [
    "authorization",
    "chatgpt-account-id",
    "originator",
    "cookie",
    "proxy-authorization",
    "x-api-key",
    "openai-organization",
    "openai-project",
    "openai-beta",
    "host",
    "connection",
    "transfer-encoding",
] as const

export interface IOpenAiCodexCredentialProvider {
    requireCredential(signal?: AbortSignal): Promise<IOAuthCredential>
    refreshAfterUnauthorized(
        observedAccessToken: string,
        observedAccountId: string,
        signal?: AbortSignal,
    ): Promise<IOAuthCredential>
}

export interface IOpenAiCodexModelsResponse {
    readonly response: Response
    readonly accountId: string
}

export type TOpenAiCodexModelsFetch = (
    signal?: AbortSignal,
) => Promise<IOpenAiCodexModelsResponse>

export interface IOpenAiCodexSearchResponse {
    readonly output: string
    readonly results?: readonly unknown[]
}

export interface IOpenAiCodexSearchRequestOptions {
    readonly signal?: AbortSignal
    readonly expectedAccountId?: string
}

export type TOpenAiCodexSearch = (
    request: object,
    options?: IOpenAiCodexSearchRequestOptions,
) => Promise<IOpenAiCodexSearchResponse>

/** Restricts OAuth-bearing requests to pinned ChatGPT Codex endpoints. */
export function createOpenAiCodexFetch(options: {
    credentials: IOpenAiCodexCredentialProvider
    fetch?: typeof fetch
    signal?: AbortSignal
    expectedAccountId?: string
}): typeof fetch {
    const rawFetch = options.fetch ?? globalThis.fetch

    const codexFetch = async (
        input: RequestInfo | URL,
        init?: RequestInit,
    ): Promise<Response> => {
        const request = new Request(input, init)
        const contract = validateRequest(request)

        const callerSignal = init?.signal
            ?? (input instanceof Request ? input.signal : request.signal)
        const signal = options.signal
            ? AbortSignal.any([callerSignal, options.signal])
            : callerSignal
        signal.throwIfAborted()
        const body = contract.kind === "responses" && request.body !== null
            ? await request.arrayBuffer()
            : undefined
        const safeHeaders = safeRequestHeaders(request, contract)

        const send = (
            credential: IRequiredCredential,
        ): Promise<Response> => {
            signal.throwIfAborted()
            const headers = new Headers(safeHeaders)
            headers.set("Authorization", `Bearer ${credential.access}`)
            headers.set("ChatGPT-Account-Id", credential.accountId)
            headers.set("originator", OPENAI_OAUTH_ORIGINATOR)
            headers.set("OpenAI-Beta", "responses=experimental")
            if (contract.kind === "models") {
                headers.set("version", OPENAI_CODEX_CLIENT_VERSION)
            }

            return rawFetch(contract.url, {
                method: contract.method,
                headers,
                ...(body === undefined ? {} : { body: body.slice(0) }),
                redirect: "error",
                credentials: "omit",
                signal,
            })
        }

        return (await authenticatedRequest(
            options.credentials,
            signal,
            send,
            options.expectedAccountId,
        )).response
    }

    const preconnect: typeof globalThis.fetch.preconnect = () => undefined
    return Object.assign(codexFetch, { preconnect })
}

/** Fetches the account catalog and reports which credential authorized it. */
export function createOpenAiCodexModelsFetch(options: {
    credentials: IOpenAiCodexCredentialProvider
    fetch?: typeof fetch
    signal?: AbortSignal
}): TOpenAiCodexModelsFetch {
    const rawFetch = options.fetch ?? globalThis.fetch

    return async (callerSignal) => {
        const signal = combinedSignal(callerSignal, options.signal)
        const result = await authenticatedRequest(
            options.credentials,
            signal,
            (credential) => {
                const headers = new Headers({ Accept: "application/json" })
                headers.set("Authorization", `Bearer ${credential.access}`)
                headers.set("ChatGPT-Account-Id", credential.accountId)
                headers.set("originator", OPENAI_OAUTH_ORIGINATOR)
                headers.set("OpenAI-Beta", "responses=experimental")
                headers.set("version", OPENAI_CODEX_CLIENT_VERSION)
                return rawFetch(OPENAI_CODEX_MODELS_URL, {
                    method: "GET",
                    headers,
                    redirect: "error",
                    credentials: "omit",
                    signal,
                })
            },
        )
        return {
            response: result.response,
            accountId: result.credential.accountId,
        }
    }
}

/** Sends one bounded JSON request to the standalone Codex search endpoint. */
export function createOpenAiCodexSearch(options: {
    credentials: IOpenAiCodexCredentialProvider
    fetch?: typeof fetch
    signal?: AbortSignal
}): TOpenAiCodexSearch {
    const rawFetch = options.fetch ?? globalThis.fetch

    return async (request, requestOptions) => {
        const body = JSON.stringify(request)
        if (new TextEncoder().encode(body).byteLength > SEARCH_MAX_REQUEST_BYTES) {
            throw new RangeError("OpenAI web search request is too large")
        }

        const signal = combinedSignal(requestOptions?.signal, options.signal)
        signal.throwIfAborted()
        const result = await authenticatedRequest(
            options.credentials,
            signal,
            (credential) => {
                const headers = new Headers({
                    Accept: "application/json",
                    "Content-Type": "application/json",
                })
                headers.set("Authorization", `Bearer ${credential.access}`)
                headers.set("ChatGPT-Account-Id", credential.accountId)
                headers.set("originator", OPENAI_OAUTH_ORIGINATOR)
                headers.set("OpenAI-Beta", "responses=experimental")
                headers.set("version", OPENAI_CODEX_CLIENT_VERSION)
                return rawFetch(OPENAI_CODEX_SEARCH_URL, {
                    method: "POST",
                    headers,
                    body,
                    redirect: "error",
                    credentials: "omit",
                    signal,
                })
            },
            requestOptions?.expectedAccountId,
        )

        if (!result.response.ok) {
            await result.response.body?.cancel().catch(() => {})
            throw new Error(
                `OpenAI web search failed with HTTP ${result.response.status}`,
            )
        }

        const payload = parseSearchResponse(
            await boundedResponseText(
                result.response,
                SEARCH_MAX_RESPONSE_BYTES,
                signal,
            ),
        )
        return payload.results === undefined
            ? { output: payload.output }
            : { output: payload.output, results: payload.results }
    }
}

interface IRequiredCredential {
    readonly access: string
    readonly accountId: string
}

interface IAuthenticatedResponse {
    readonly response: Response
    readonly credential: IRequiredCredential
}

type TOpenAiCodexRequestContract =
    | {
        readonly kind: "responses"
        readonly url: typeof OPENAI_CODEX_RESPONSES_URL
        readonly method: "POST"
    }
    | {
        readonly kind: "models"
        readonly url: typeof OPENAI_CODEX_MODELS_URL
        readonly method: "GET"
    }

function validateRequest(request: Request): TOpenAiCodexRequestContract {
    if (request.url === OPENAI_CODEX_MODELS_URL) {
        if (request.method !== "GET" || request.body !== null) {
            throw new TypeError("OpenAI Codex model requests require GET without a body")
        }
        return {
            kind: "models",
            url: OPENAI_CODEX_MODELS_URL,
            method: "GET",
        }
    }

    if (request.url !== OPENAI_CODEX_RESPONSES_URL) {
        throw new TypeError("OpenAI Codex OAuth requests require a pinned endpoint")
    }
    if (request.method !== "POST") {
        throw new TypeError("OpenAI Codex response requests require POST")
    }

    const mediaType = request.headers
        .get("content-type")
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase()
    if (mediaType !== "application/json") {
        throw new TypeError("OpenAI Codex response requests require application/json")
    }
    return {
        kind: "responses",
        url: OPENAI_CODEX_RESPONSES_URL,
        method: "POST",
    }
}

function safeRequestHeaders(
    request: Request,
    contract: TOpenAiCodexRequestContract,
): Headers {
    if (contract.kind === "models") {
        return new Headers({ Accept: "application/json" })
    }

    const headers = new Headers(request.headers)
    for (const header of STRIPPED_HEADERS) headers.delete(header)
    return headers
}

async function authenticatedRequest(
    credentials: IOpenAiCodexCredentialProvider,
    signal: AbortSignal,
    send: (credential: IRequiredCredential) => Promise<Response>,
    expectedAccountId?: string,
): Promise<IAuthenticatedResponse> {
    let credential = requireCredentialFields(
        await credentials.requireCredential(signal),
    )
    requireExpectedAccount(credential, expectedAccountId)
    let response = await send(credential)
    if (response.status !== 401) return { response, credential }

    await response.body?.cancel()
    credential = requireCredentialFields(
        await credentials.refreshAfterUnauthorized(
            credential.access,
            credential.accountId,
            signal,
        ),
    )
    requireExpectedAccount(credential, expectedAccountId)
    response = await send(credential)
    return { response, credential }
}

function requireExpectedAccount(
    credential: IRequiredCredential,
    expectedAccountId: string | undefined,
): void {
    if (expectedAccountId && credential.accountId !== expectedAccountId) {
        throw new Error(
            "OpenAI account changed; run `/model` to refresh available models",
        )
    }
}

function combinedSignal(
    callerSignal: AbortSignal | undefined,
    lifetimeSignal: AbortSignal | undefined,
): AbortSignal {
    if (callerSignal && lifetimeSignal) {
        return AbortSignal.any([callerSignal, lifetimeSignal])
    }
    return callerSignal ?? lifetimeSignal ?? new AbortController().signal
}

function requireCredentialFields(
    credential: IOAuthCredential,
): IRequiredCredential {
    const access = credential.access.trim()
    if (!access) throw new Error("OpenAI OAuth credential has no access token")

    const accountId = credential.accountId?.trim()
    if (!accountId) throw new Error("OpenAI OAuth credential has no account ID")

    return { access, accountId }
}

function parseSearchResponse(value: string): IOpenAiCodexSearchResponse {
    let payload: unknown
    try {
        payload = JSON.parse(value)
    } catch {
        throw new Error("OpenAI web search returned an invalid response")
    }
    if (
        payload === null
        || typeof payload !== "object"
        || Array.isArray(payload)
        || typeof (payload as Record<string, unknown>).output !== "string"
    ) {
        throw new Error("OpenAI web search returned an invalid response")
    }

    const record = payload as Record<string, unknown>
    if (
        record.results !== undefined
        && record.results !== null
        && !Array.isArray(record.results)
    ) {
        throw new Error("OpenAI web search returned an invalid response")
    }
    return {
        output: record.output as string,
        ...(Array.isArray(record.results) ? { results: record.results } : {}),
    }
}

async function boundedResponseText(
    response: Response,
    maximumBytes: number,
    signal: AbortSignal,
): Promise<string> {
    const declaredLength = Number(response.headers.get("content-length"))
    if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
        await response.body?.cancel().catch(() => {})
        throw new RangeError("OpenAI web search response is too large")
    }
    if (!response.body) return ""

    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let byteLength = 0
    try {
        while (true) {
            signal.throwIfAborted()
            const chunk = await reader.read()
            if (chunk.done) break
            byteLength += chunk.value.byteLength
            if (byteLength > maximumBytes) {
                await reader.cancel()
                throw new RangeError("OpenAI web search response is too large")
            }
            chunks.push(chunk.value)
        }
    } finally {
        reader.releaseLock()
    }

    const bytes = new Uint8Array(byteLength)
    let offset = 0
    for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
    }
    return new TextDecoder().decode(bytes)
}
