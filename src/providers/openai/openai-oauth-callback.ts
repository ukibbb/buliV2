import {
    createServer,
    type Server,
    type ServerResponse,
} from "node:http"

import { OPENAI_OAUTH_CALLBACK_URL } from "@/providers/openai/openai-constants"

const CALLBACK_HOST = "127.0.0.1"
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000

const callbackUrl = new URL(OPENAI_OAUTH_CALLBACK_URL)
const CALLBACK_PORT = Number(callbackUrl.port)
const CALLBACK_PATH = callbackUrl.pathname

export interface IOpenAiOAuthCallbackOptions {
    readonly expectedState: string
    readonly signal: AbortSignal
}

export interface IOpenAiOAuthCallback {
    readonly waitForCode: () => Promise<string>
    readonly close: () => Promise<void>
}

export type TOpenAiOAuthCallbackFactory = (
    options: IOpenAiOAuthCallbackOptions,
) => Promise<IOpenAiOAuthCallback>

/** Starts the fixed OpenAI callback listener on IPv4 loopback only. */
export async function startOpenAiOAuthCallback(
    options: IOpenAiOAuthCallbackOptions,
): Promise<IOpenAiOAuthCallback> {
    throwIfAborted(options.signal)

    let resolveCode: (code: string) => void = () => undefined
    let rejectCode: (error: Error) => void = () => undefined
    const codePromise = new Promise<string>((resolve, reject) => {
        resolveCode = resolve
        rejectCode = reject
    })
    void codePromise.catch(() => undefined)

    let server: Server
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | undefined
    let closePromise: Promise<void> | undefined

    const stopServer = (): Promise<void> => {
        if (closePromise) return closePromise

        closePromise = new Promise((resolve) => {
            if (!server.listening) {
                resolve()
                return
            }
            let finished = false
            const finish = (): void => {
                if (finished) return
                finished = true
                clearTimeout(shutdownTimer)
                resolve()
            }
            const shutdownTimer = setTimeout(finish, 1_000)
            shutdownTimer.unref()
            server.close(finish)
            server.closeAllConnections()
        })
        return closePromise
    }

    const cleanWait = (): void => {
        if (timeout) clearTimeout(timeout)
        options.signal.removeEventListener("abort", onAbort)
    }

    const settle = (
        result: { readonly code: string } | { readonly error: Error },
    ): void => {
        if (settled) return
        settled = true
        cleanWait()
        if ("code" in result) resolveCode(result.code)
        else rejectCode(result.error)
        void stopServer()
    }

    const onAbort = (): void => {
        settle({ error: abortReason(options.signal) })
    }

    server = createServer((request, response) => {
        try {
            const requestUrl = new URL(request.url ?? "/", callbackUrl.origin)

            if (requestUrl.pathname !== CALLBACK_PATH) {
                sendHtml(response, 404, "OAuth callback route not found.", false)
                return
            }
            if (request.method !== "GET") {
                response.setHeader("Allow", "GET")
                sendHtml(response, 405, "OAuth callback must use GET.", false)
                return
            }

            const states = requestUrl.searchParams.getAll("state")
            if (states.length !== 1 || states[0] !== options.expectedState) {
                sendHtml(response, 400, "OAuth state did not match.", false)
                return
            }

            const providerError = requestUrl.searchParams.get("error")
            if (providerError) {
                const description = requestUrl.searchParams.get("error_description")
                const message = description || providerError
                sendHtml(response, 400, `Authorization failed: ${message}`, false)
                settle({ error: new Error(`OpenAI authorization failed: ${message}`) })
                return
            }

            const codes = requestUrl.searchParams.getAll("code")
            if (codes.length !== 1 || !codes[0]) {
                sendHtml(response, 400, "Authorization code is missing.", false)
                return
            }

            sendHtml(
                response,
                200,
                "ChatGPT authorization was received. You can close this window.",
                true,
            )
            settle({ code: codes[0] })
        } catch {
            sendHtml(response, 400, "OAuth callback was invalid.", false)
        }
    })

    try {
        await new Promise<void>((resolve, reject) => {
            const onListenError = (): void => {
                reject(new Error("Unable to bind the OpenAI OAuth callback listener"))
            }
            server.once("error", onListenError)
            server.listen(CALLBACK_PORT, CALLBACK_HOST, () => {
                server.removeListener("error", onListenError)
                resolve()
            })
        })
    } catch {
        await stopServer()
        throw new Error("Unable to bind the OpenAI OAuth callback listener")
    }

    const onRuntimeError = (): void => {
        settle({ error: new Error("OpenAI OAuth callback listener failed") })
    }
    timeout = setTimeout(() => {
        settle({ error: timeoutError("OpenAI OAuth callback timed out") })
    }, CALLBACK_TIMEOUT_MS)
    server.once("error", onRuntimeError)
    options.signal.addEventListener("abort", onAbort, { once: true })

    if (options.signal.aborted) {
        onAbort()
        await stopServer()
        throw abortReason(options.signal)
    }

    return {
        waitForCode: () => codePromise,
        close: async () => {
            server.removeListener("error", onRuntimeError)
            if (!settled) {
                settle({ error: abortError("OpenAI OAuth callback was closed") })
            }
            cleanWait()
            await stopServer()
        },
    }
}

export function escapeOpenAiOAuthHtml(value: string): string {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;")
}

export function renderOpenAiOAuthCallbackHtml(
    message: string,
    success: boolean,
): string {
    const title = success ? "Authentication complete" : "Authentication failed"
    const escapedTitle = escapeOpenAiOAuthHtml(title)
    const escapedMessage = escapeOpenAiOAuthHtml(message)

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapedTitle}</title>
  <style>body{font-family:system-ui,sans-serif;max-width:42rem;margin:12vh auto;padding:2rem;background:#111827;color:#f9fafb}main{border:1px solid #374151;border-radius:12px;padding:2rem}p{line-height:1.6;color:#d1d5db}</style>
</head>
<body><main><h1>${escapedTitle}</h1><p>${escapedMessage}</p></main></body>
</html>`
}

function sendHtml(
    response: ServerResponse,
    status: number,
    message: string,
    success: boolean,
): void {
    response.writeHead(status, {
        "Cache-Control": "no-store",
        "Content-Security-Policy":
            "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        "Content-Type": "text/html; charset=utf-8",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
    })
    response.end(renderOpenAiOAuthCallbackHtml(message, success))
}

function throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) throw abortReason(signal)
}

function abortReason(signal: AbortSignal): Error {
    return signal.reason instanceof Error
        ? signal.reason
        : abortError("OpenAI OAuth login was cancelled")
}

function abortError(message: string): Error {
    const error = new Error(message)
    error.name = "AbortError"
    return error
}

function timeoutError(message: string): Error {
    const error = new Error(message)
    error.name = "TimeoutError"
    return error
}
