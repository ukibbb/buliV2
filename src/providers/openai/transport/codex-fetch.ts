import type { IOAuthCredential } from "@/authentication"
import {
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

/** Restricts OAuth-bearing requests to the pinned ChatGPT Codex endpoint. */
export function createOpenAiCodexFetch(options: {
    credentials: IOpenAiCodexCredentialProvider
    fetch?: typeof fetch
    signal?: AbortSignal
}): typeof fetch {
    const rawFetch = options.fetch ?? globalThis.fetch

    const codexFetch = async (
        input: RequestInfo | URL,
        init?: RequestInit,
    ): Promise<Response> => {
        const request = new Request(input, init)
        validateRequest(request)

        const callerSignal = init?.signal
            ?? (input instanceof Request ? input.signal : request.signal)
        const signal = options.signal
            ? AbortSignal.any([callerSignal, options.signal])
            : callerSignal
        signal.throwIfAborted()
        const body = request.body === null
            ? undefined
            : await request.arrayBuffer()
        const safeHeaders = new Headers(request.headers)
        for (const header of STRIPPED_HEADERS) safeHeaders.delete(header)

        const send = (
            credential: IRequiredCredential,
        ): Promise<Response> => {
            signal.throwIfAborted()
            const headers = new Headers(safeHeaders)
            headers.set("Authorization", `Bearer ${credential.access}`)
            headers.set("ChatGPT-Account-Id", credential.accountId)
            headers.set("originator", OPENAI_OAUTH_ORIGINATOR)
            headers.set("OpenAI-Beta", "responses=experimental")

            return rawFetch(OPENAI_CODEX_RESPONSES_URL, {
                method: "POST",
                headers,
                ...(body === undefined ? {} : { body: body.slice(0) }),
                redirect: "error",
                credentials: "omit",
                signal,
            })
        }

        const credential = requireCredentialFields(
            await options.credentials.requireCredential(signal),
        )
        const response = await send(credential)
        if (response.status !== 401) return response

        await response.body?.cancel()
        const refreshed = requireCredentialFields(
            await options.credentials.refreshAfterUnauthorized(
                credential.access,
                credential.accountId,
                signal,
            ),
        )
        return send(refreshed)
    }

    const preconnect: typeof globalThis.fetch.preconnect = () => undefined
    return Object.assign(codexFetch, { preconnect })
}

interface IRequiredCredential {
    readonly access: string
    readonly accountId: string
}

function validateRequest(request: Request): void {
    if (request.url !== OPENAI_CODEX_RESPONSES_URL) {
        throw new TypeError("OpenAI Codex OAuth requests require the pinned endpoint")
    }
    if (request.method !== "POST") {
        throw new TypeError("OpenAI Codex OAuth requests require POST")
    }

    const mediaType = request.headers
        .get("content-type")
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase()
    if (mediaType !== "application/json") {
        throw new TypeError("OpenAI Codex OAuth requests require application/json")
    }
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
