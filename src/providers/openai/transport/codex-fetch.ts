import type { IOAuthCredential } from "@/authentication"
import {
    OPENAI_CODEX_CLIENT_VERSION,
    OPENAI_CODEX_MODELS_URL,
    OPENAI_CODEX_RESPONSES_URL,
    OPENAI_OAUTH_ORIGINATOR,
} from "@/providers/openai/constants"

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
