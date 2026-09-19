import { expect, mock, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FileAuthStore } from "@/authentication/file-auth-store"
import { createAuthentication } from "./create-authentication"

test("composition exposes Kimi and uses injected fetch and store independently of OpenAI", async () => {
    const directory = await mkdtemp(join(tmpdir(), "buli-auth-composition-"))
    const store = new FileAuthStore(join(directory, "auth.json"))
    const request = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe("https://api.kimi.com/coding/v1/models")
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer synthetic-kimi")
        return Response.json({ data: [] })
    })
    const root = new AbortController()
    const composition = createAuthentication({
        store, signal: root.signal,
        fetch: Object.assign(request, { preconnect: () => undefined }),
    })
    try {
        await store.set("kimi-coding", { type: "api_key", key: "synthetic-kimi" })
        expect((await composition.kimi.status()).connected).toBe(true)
        expect(await store.get("openai")).toBeUndefined()
        expect((await composition.deepseek.status()).connected).toBe(false)
        expect((await composition.service.listProviders()).map(provider => provider.providerId))
            .toEqual(["openai", "kimi-coding", "deepseek"])
        const response = await composition.kimi.authenticatedFetch("https://api.kimi.com/coding/v1/models")
        await response.json()
        expect(request).toHaveBeenCalledTimes(1)
        root.abort()
        await expect(composition.kimi.status()).rejects.toThrow()
        await expect(composition.deepseek.status()).rejects.toThrow()
    } finally {
        await composition.service.dispose()
        await rm(directory, { recursive: true, force: true })
    }
})
