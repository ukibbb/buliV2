export interface IDeepSeekFetchOptions {
    readonly fetch: typeof fetch
    readonly signal: AbortSignal
    readonly requireApiKey: (signal: AbortSignal) => Promise<string>
    readonly trackBody: (completion: Promise<void>) => void
}

const MODELS_URL = "https://api.deepseek.com/models"
const CHAT_URL = "https://api.deepseek.com/chat/completions"

export function createDeepSeekFetch(options: IDeepSeekFetchOptions): typeof fetch {
    const run = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        options.signal.throwIfAborted()
        let request: Request
        try {
            request = new Request(input, init)
        } catch {
            throw new Error("Invalid DeepSeek request")
        }
        const signal = AbortSignal.any([request.signal, options.signal])
        signal.throwIfAborted()
        const isModels = request.url === MODELS_URL && request.method === "GET"
        const isChat = request.url === CHAT_URL && request.method === "POST"
        if (!isModels && !isChat) {
            throw new Error("DeepSeek request endpoint or method is not allowed")
        }
        const body = isChat ? await readJsonObjectBody(request, signal) : undefined

        try {
            const key = await options.requireApiKey(signal)
            signal.throwIfAborted()
            const headers = new Headers({
                accept: isChat ? "application/json, text/event-stream" : "application/json",
                authorization: `Bearer ${key}`,
                "user-agent": "buli/0.9.2",
            })
            if (isChat) headers.set("content-type", "application/json")
            const response = await options.fetch(isChat ? CHAT_URL : MODELS_URL, {
                method: isChat ? "POST" : "GET",
                headers,
                ...(body === undefined ? {} : { body }),
                signal,
                redirect: "error",
                credentials: "omit",
            })
            if (signal.aborted) {
                await response.body?.cancel().catch(() => {})
                signal.throwIfAborted()
            }
            if (response.status >= 300 && response.status < 400) {
                await response.body?.cancel().catch(() => {})
                throw new Error("Unexpected redirect")
            }
            return protectResponse(response, signal, options.trackBody)
        } catch {
            signal.throwIfAborted()
            throw new Error("DeepSeek authenticated request failed; check local credentials and connectivity")
        }
    }
    return Object.assign(run, { preconnect: options.fetch.preconnect })
}

async function readJsonObjectBody(request: Request, signal: AbortSignal): Promise<string> {
    if (!request.body) throw new Error("Invalid DeepSeek JSON request body")
    const reader = request.body.getReader()
    const cancel = () => { void reader.cancel().catch(() => {}) }
    signal.addEventListener("abort", cancel, { once: true })
    try {
        signal.throwIfAborted()
        const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
        let body = ""
        while (true) {
            const item = await reader.read()
            signal.throwIfAborted()
            if (item.done) break
            body += decoder.decode(item.value, { stream: true })
        }
        body += decoder.decode()
        const parsed: unknown = JSON.parse(body)
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("Expected an object")
        }
        return body
    } catch {
        cancel()
        signal.throwIfAborted()
        throw new Error("Invalid DeepSeek JSON request body")
    } finally {
        signal.removeEventListener("abort", cancel)
        reader.releaseLock()
    }
}

function protectResponse(
    response: Response,
    signal: AbortSignal,
    trackBody: (completion: Promise<void>) => void,
): Response {
    if (!response.body) return response
    const reader = response.body.getReader()
    const completion = Promise.withResolvers<void>()
    trackBody(completion.promise)
    let finished = false
    let controller: ReadableStreamDefaultController<Uint8Array>
    const finish = () => {
        if (finished) return
        finished = true
        signal.removeEventListener("abort", abort)
        completion.resolve()
    }
    const cancel = async () => {
        try { await reader.cancel() } catch { /* Do not expose upstream errors. */ }
        finally { finish() }
    }
    const abort = () => {
        if (finished) return
        controller.error(new Error("DeepSeek response was cancelled"))
        void cancel()
    }
    const body = new ReadableStream<Uint8Array>({
        start(value) {
            controller = value
            signal.addEventListener("abort", abort, { once: true })
            if (signal.aborted) abort()
        },
        async pull() {
            try {
                const item = await reader.read()
                if (finished || signal.aborted) return
                if (item.done) {
                    controller.close()
                    finish()
                } else controller.enqueue(item.value)
            } catch {
                if (finished || signal.aborted) return
                controller.error(new Error("DeepSeek response stream failed"))
                await cancel()
            }
        },
        cancel,
    }, { highWaterMark: 0 })
    return new Response(body, {
        status: response.status,
        headers: response.headers,
    })
}
