import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FileAuthStore } from "@/authentication/file-auth-store"
import { NovibeAuth } from "./novibe-auth"
import { listenForAuthorization } from "./loopback"

const issuer = "http://localhost:8000"
const resource = "http://127.0.0.1:8000/mcp/"

test("loopback rejects wrong state and issuer before accepting one code", async () => {
    const receiver = await listenForAuthorization("expected", issuer, AbortSignal.timeout(5000))
    try {
        expect((await fetch(`${receiver.redirectUri}?state=wrong&iss=${encodeURIComponent(issuer)}&code=code`)).status).toBe(400)
        expect((await fetch(`${receiver.redirectUri}?state=expected&iss=wrong&code=code`)).status).toBe(400)
        expect((await fetch(`${receiver.redirectUri}?state=expected&iss=${encodeURIComponent(issuer)}&code=code`)).status).toBe(200)
        expect(await receiver.code).toBe("code")
        expect((await fetch(`${receiver.redirectUri}?state=expected&iss=${encodeURIComponent(issuer)}&code=code`)).status).toBe(400)
    } finally { await receiver.close() }
})

test("login keeps tokens outside UI results; refresh is serialized and logout removes credentials", async () => {
    const directory = await mkdtemp(join(tmpdir(), "buli-novibe-"))
    const store = new FileAuthStore(join(directory, "auth.json"))
    let refreshes = 0
    let revocations = 0
    const request = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith("/revoke")) { revocations++; return new Response(null, { status: 200 }) }
        const body = init?.body as URLSearchParams
        expect(body.get("client_id")).toBe("buli")
        expect(body.get("resource")).toBe(resource)
        if (body.get("grant_type") === "refresh_token") refreshes++
        else { expect(body.get("code")).toBe("test-code"); expect(body.get("code_verifier")?.length).toBeGreaterThan(43) }
        return Response.json({ access_token: "private-access", refresh_token: "private-refresh", token_type: "Bearer", scope: "novibe:mcp", expires_in: 900 })
    }, { preconnect: () => {} }) as typeof fetch
    const auth = new NovibeAuth(store, request)
    try {
        const message = await auth.login(async raw => {
            const url = new URL(raw)
            expect(url.origin).toBe(issuer)
            const callback = new URL(url.searchParams.get("redirect_uri")!)
            callback.search = new URLSearchParams({ state: url.searchParams.get("state")!, iss: issuer, code: "test-code" }).toString()
            await fetch(callback)
        }, AbortSignal.timeout(5000))
        expect(message).not.toContain("private-")
        const stored = await store.get("novibe")
        expect(stored?.type).toBe("mcp_oauth")
        if (stored?.type !== "mcp_oauth") throw new Error("Missing credential")
        await store.set("novibe", { ...stored, expires: 0 })
        await Promise.all([auth.access(AbortSignal.timeout(5000)), auth.access(AbortSignal.timeout(5000))])
        expect(refreshes).toBe(1)
        expect((await auth.provider(AbortSignal.timeout(5000)).tokens())?.access_token).toBe("private-access")
        await auth.logout()
        expect(revocations).toBe(1)
        expect(await store.get("novibe")).toBeUndefined()
    } finally { auth.dispose(); await rm(directory, { recursive: true, force: true }) }
})
