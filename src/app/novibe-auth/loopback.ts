import { createServer } from "node:http"

/** Receives one state-bound OAuth response on an ephemeral IPv4 loopback port. */
export async function listenForAuthorization(state: string, issuer: string, signal: AbortSignal) {
    signal.throwIfAborted()
    const result = Promise.withResolvers<string>()
    void result.promise.catch(() => {})
    let settled = false
    const server = createServer((request, response) => {
        const url = new URL(request.url ?? "/", "http://127.0.0.1")
        const valid = request.method === "GET" && url.pathname === "/novibe/callback"
            && url.searchParams.getAll("state").length === 1 && url.searchParams.get("state") === state
            && url.searchParams.getAll("iss").length === 1 && url.searchParams.get("iss") === issuer
        response.setHeader("Cache-Control", "no-store")
        response.setHeader("Referrer-Policy", "no-referrer")
        response.setHeader("Content-Type", "text/plain; charset=utf-8")
        if (!valid || settled) { response.writeHead(400); response.end("Invalid authorization response."); return }
        if (url.searchParams.has("error")) {
            settled = true
            response.end("Authorization declined. Return to Buli.")
            result.reject(new Error("NoVibe: odmówiono dostępu."))
            return
        }
        const codes = url.searchParams.getAll("code")
        if (codes.length !== 1 || !codes[0] || codes[0].length > 256) {
            response.writeHead(400); response.end("Invalid authorization code."); return
        }
        settled = true
        response.end("Authorization response received. Return to Buli to check the result.")
        result.resolve(codes[0])
    })
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject)
        server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve() })
    })
    const abort = () => { settled = true; result.reject(new Error("NoVibe: logowanie anulowane lub przekroczono czas.")); server.closeAllConnections(); server.close() }
    const fail = () => { settled = true; result.reject(new Error("NoVibe: błąd lokalnego odbiornika.")) }
    server.on("error", fail)
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) abort()
    const address = server.address()
    if (!address || typeof address === "string") { abort(); throw new Error("NoVibe callback unavailable") }
    return {
        redirectUri: `http://127.0.0.1:${address.port}/novibe/callback`,
        code: result.promise,
        close: async () => {
            signal.removeEventListener("abort", abort)
            server.removeListener("error", fail)
            server.closeAllConnections()
            await new Promise<void>(resolve => server.close(() => resolve()))
            if (!settled) result.reject(new Error("NoVibe login closed"))
        },
    }
}
