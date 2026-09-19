import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { FileAuthStore } from "@/authentication/file-auth-store"
import type { IAuthInteraction, IAuthPrompt } from "@/authentication/contracts"
import { KimiAuth } from "./kimi-auth"
import { createAuthentication } from "@/app/bootstrap/create-authentication"

async function fixture(run: (auth: KimiAuth, store: FileAuthStore) => Promise<void>) {
    const directory = await mkdtemp(join(tmpdir(), "buli-kimi-auth-"))
    const store = new FileAuthStore(join(directory, "auth.json"))
    const auth = new KimiAuth({ store })
    try { await run(auth, store) } finally {
        await auth.dispose()
        await rm(directory, { recursive: true, force: true })
    }
}

function interaction(prompt: IAuthInteraction["prompt"], signal = new AbortController().signal): IAuthInteraction {
    return { signal, notify: () => {}, prompt }
}

test("stores a local API key without changing OpenAI and removes only Kimi", async () => {
    await fixture(async (auth, store) => {
        const openai = { type: "oauth", access: "fake", refresh: "fake-refresh", expires: 100 } as const
        await store.set("openai", openai)
        expect((await auth.status()).connected).toBe(false)
        await auth.login("api-key", interaction(async (prompt) => {
            expect(prompt.type).toBe("secret")
            expect(prompt.message).toContain("not verified online")
            return " synthetic-key "
        }))
        expect(await store.get("kimi-coding")).toEqual({ type: "api_key", key: "synthetic-key" })
        expect(await auth.status()).toEqual({ providerId: "kimi-coding", connected: true })
        expect(await auth.logout(new AbortController().signal)).toBe(true)
        expect(await auth.logout(new AbortController().signal)).toBe(false)
        expect(await store.get("openai")).toEqual(openai)
    })
})

test("rejects invalid methods, key format and stored credential types without leaking keys", async () => {
    await fixture(async (auth, store) => {
        await expect(auth.login("oauth", interaction(async () => "unused"))).rejects.toThrow("Unsupported")
        for (const key of ["", " ", "secret with spaces", "secret\u0000suffix"]) {
            await expect(auth.login("api-key", interaction(async () => key))).rejects.toThrow("Invalid Kimi Code API key format")
        }
        expect(await store.get(auth.id)).toBeUndefined()
        await store.set(auth.id, { type: "oauth", access: "fake", refresh: "fake", expires: 100 })
        await expect(auth.status()).rejects.toThrow("requires an API key")
    })
})

for (const mode of ["cancel", "logout", "replace", "dispose", "external-logout"] as const) {
    test(`${mode} prevents an old login from persisting`, async () => {
        await fixture(async (auth, store) => {
            const entered = Promise.withResolvers<IAuthPrompt>()
            const finish = Promise.withResolvers<string>()
            const controller = new AbortController()
            const result = auth.login("api-key", interaction(async (prompt) => {
                entered.resolve(prompt)
                return finish.promise
            }, controller.signal)).then(() => "unexpected-success", () => "rejected")
            const prompt = await entered.promise
            let disposing: Promise<void> | undefined
            if (mode === "cancel") controller.abort()
            if (mode === "logout") await auth.logout(new AbortController().signal)
            if (mode === "external-logout") await store.remove(auth.id)
            if (mode === "replace") await auth.login("api-key", interaction(async () => "new-key"))
            if (mode === "dispose") {
                disposing = auth.dispose()
                expect(auth.dispose()).toBe(disposing)
                let disposed = false
                void disposing.then(() => { disposed = true })
                await Promise.resolve()
                expect(disposed).toBe(false)
            }
            if (mode !== "external-logout") expect(prompt.signal.aborted).toBe(true)
            finish.resolve("old-key")
            expect(await result).toBe("rejected")
            await disposing
            expect(await store.get(auth.id)).toEqual(mode === "replace"
                ? { type: "api_key", key: "new-key" } : undefined)
            if (mode === "dispose") await expect(auth.status()).rejects.toThrow()
        })
    })
}

test("root cancellation aborts a prompt and waits for its cleanup", async () => {
    await fixture(async (_auth, store) => {
        const root = new AbortController()
        const auth = new KimiAuth({ store, signal: root.signal })
        const entered = Promise.withResolvers<void>()
        const result = auth.login("api-key", interaction((prompt) => new Promise((_resolve, reject) => {
            prompt.signal.addEventListener("abort", () => reject(prompt.signal.reason), { once: true })
            entered.resolve()
        }))).catch((error: unknown) => error)
        await entered.promise
        const reason = new Error("root stopped")
        root.abort(reason)
        await auth.dispose()
        expect(await result).toBe(reason)
        expect(await store.get(auth.id)).toBeUndefined()
        await expect(auth.login("api-key", interaction(async () => "unused"))).rejects.toBe(reason)
    })
})

test("transport rejects missing credentials and work after disposal without fetch", async () => {
    await fixture(async (_auth, store) => {
        let calls = 0
        const auth = new KimiAuth({ store, fetch: Object.assign(async () => {
            calls++
            return new Response(null, { status: 204 })
        }, { preconnect: globalThis.fetch.preconnect }) })
        await expect(auth.authenticatedFetch("https://api.kimi.com/coding/v1/models"))
            .rejects.toThrow("check local credentials")
        await auth.dispose()
        await expect(auth.authenticatedFetch("https://api.kimi.com/coding/v1/models")).rejects.toThrow()
        expect(calls).toBe(0)
    })
})

for (const mode of ["caller", "dispose"] as const) {
    test(`${mode} aborts an unread response body and awaits its cancellation`, async () => {
        await fixture(async (_auth, store) => {
            await store.set("kimi-coding", { type: "api_key", key: "synthetic-key" })
            const cancelled = Promise.withResolvers<void>()
            const cleanup = Promise.withResolvers<void>()
            const controller = new AbortController()
            let fetchSignal: AbortSignal | null | undefined
            const auth = new KimiAuth({ store, fetch: Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => {
                fetchSignal = init?.signal
                return new Response(new ReadableStream<Uint8Array>({
                    cancel() { cancelled.resolve(); return cleanup.promise },
                }))
            }, { preconnect: globalThis.fetch.preconnect }) })
            try {
                const response = await auth.authenticatedFetch("https://api.kimi.com/coding/v1/models", { signal: controller.signal })
                if (mode === "caller") controller.abort()
                const disposing = auth.dispose()
                let finished = false
                void disposing.then(() => { finished = true })
                await cancelled.promise
                expect(fetchSignal?.aborted).toBe(true)
                expect(finished).toBe(false)
                await expect(response.text()).rejects.toThrow("Kimi response was cancelled")
                cleanup.resolve()
                await disposing
                expect(finished).toBe(true)
            } finally {
                cleanup.resolve()
                await auth.dispose()
            }
        })
    })
}

test("dispose waits for a pending credential read and prevents a late request", async () => {
    await fixture(async (_auth, store) => {
        const entered = Promise.withResolvers<void>()
        const finish = Promise.withResolvers<void>()
        let calls = 0
        store.get = async () => {
            entered.resolve()
            await finish.promise
            return { type: "api_key", key: "synthetic-key" }
        }
        const auth = new KimiAuth({ store, fetch: Object.assign(async () => {
            calls++
            return new Response()
        }, { preconnect: globalThis.fetch.preconnect }) })
        const result = auth.authenticatedFetch("https://api.kimi.com/coding/v1/models").catch((error: unknown) => error)
        await entered.promise
        const disposing = auth.dispose()
        let disposed = false
        void disposing.then(() => { disposed = true })
        await Promise.resolve()
        expect(disposed).toBe(false)
        finish.resolve()
        await disposing
        expect(await result).toBeInstanceOf(Error)
        expect(calls).toBe(0)
    })
})

test("bootstrap registers all providers using the injected store", async () => {
    await fixture(async (_auth, store) => {
        const composition = createAuthentication({ store, fetch: Object.assign(
            async () => { throw new Error("Unexpected network") },
            { preconnect: globalThis.fetch.preconnect },
        ) })
        try {
            expect((await composition.service.listProviders()).map((provider) => provider.providerId))
                .toEqual(["openai", "kimi-coding", "deepseek"])
            await composition.service.login("kimi-coding", "api-key", interaction(async () => "local-only"))
            expect(await store.get("kimi-coding")).toEqual({ type: "api_key", key: "local-only" })
        } finally {
            await composition.service.dispose()
        }
    })
})
