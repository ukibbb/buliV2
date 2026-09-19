import { expect, test } from "bun:test"
import { lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { FileAuthStore } from "@/authentication/file-auth-store"
import { withAuthFileLock } from "@/authentication/auth-file-lock"

const storeImport = `import { FileAuthStore } from ${JSON.stringify(
    join(import.meta.dir, "file-auth-store.ts"),
)};`

function startOwner(path: string) {
    const ready = Promise.withResolvers<void>()
    const child = Bun.spawn([
        process.execPath, "-e",
        `${storeImport}
        const finish = Promise.withResolvers();
        process.on("message", (message) => {
            if (message === "finish") finish.resolve();
        });
        await new FileAuthStore(process.argv[1]).modify("openai", async () => {
            process.send("locked");
            await finish.promise;
            return { type: "api_key", key: "synthetic-openai" };
        });
        process.disconnect();`,
        path,
    ], {
        cwd: join(import.meta.dir, "../.."),
        stdout: "ignore",
        stderr: "pipe",
        ipc(message) {
            if (message === "locked") ready.resolve()
        },
    })
    return {
        child,
        ready: Promise.race([
            ready.promise,
            child.exited.then(async (code) => {
                throw new Error(`Auth lock owner exited (${code}): ${await new Response(child.stderr).text()}`)
            }),
        ]),
    }
}

test("serializes modify across processes and preserves both providers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "buli-auth-process-"))
    const path = join(directory, "auth.json")
    const owner = startOwner(path)
    let mutation: Promise<unknown> | undefined
    const controller = new AbortController()
    try {
        await owner.ready
        let entered = false
        mutation = new FileAuthStore(path).modify("kimi-coding", async () => {
            entered = true
            return { type: "api_key", key: "synthetic-kimi" }
        }, controller.signal)
        await Bun.sleep(75)
        expect(entered).toBe(false)
        owner.child.send("finish")
        expect(await owner.child.exited).toBe(0)
        await mutation
        expect(entered).toBe(true)
        const store = new FileAuthStore(path)
        expect(await store.get("openai")).toEqual({ type: "api_key", key: "synthetic-openai" })
        expect(await store.get("kimi-coding")).toEqual({ type: "api_key", key: "synthetic-kimi" })
    } finally {
        controller.abort()
        owner.child.kill("SIGKILL")
        await owner.child.exited
        await mutation?.catch(() => {})
        await rm(directory, { recursive: true, force: true })
    }
})

test("SIGKILL releases the auth lock without stale-file recovery", async () => {
    const directory = await mkdtemp(join(tmpdir(), "buli-auth-crash-"))
    const path = join(directory, "auth.json")
    const owner = startOwner(path)
    try {
        await owner.ready
        owner.child.kill("SIGKILL")
        await owner.child.exited
        const store = new FileAuthStore(path)
        await store.set("kimi-coding", { type: "api_key", key: "after-crash" }, AbortSignal.timeout(2000))
        expect(await store.get("openai")).toBeUndefined()
        expect(await store.get("kimi-coding")).toEqual({ type: "api_key", key: "after-crash" })
    } finally {
        owner.child.kill("SIGKILL")
        await owner.child.exited
        await rm(directory, { recursive: true, force: true })
    }
})

test("canonicalizes auth symlinks and preserves them during writes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "buli-auth-alias-"))
    const path = join(directory, "auth.json")
    const alias = join(directory, "alias.json")
    try {
        const store = new FileAuthStore(path)
        await store.set("openai", { type: "api_key", key: "before" })
        await symlink(path, alias)
        await withAuthFileLock(path, undefined, async () => {
            const controller = new AbortController()
            const timer = setTimeout(() => controller.abort(new Error("cancel alias")), 75)
            try {
                await expect(new FileAuthStore(alias).set(
                    "openai", { type: "api_key", key: "blocked" }, controller.signal,
                )).rejects.toThrow("cancel alias")
            } finally {
                clearTimeout(timer)
            }
        })
        await new FileAuthStore(alias).set("kimi-coding", { type: "api_key", key: "after" })
        expect((await lstat(alias)).isSymbolicLink()).toBe(true)
        expect(await store.get("openai")).toEqual({ type: "api_key", key: "before" })
        expect(await store.get("kimi-coding")).toEqual({ type: "api_key", key: "after" })
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})

test("lock-file errors reject without invoking the transaction", async () => {
    const directory = await mkdtemp(join(tmpdir(), "buli-auth-lock-error-"))
    const path = join(directory, "auth.json")
    try {
        await mkdir(`${path}.lock`)
        let entered = false
        await expect(withAuthFileLock(path, undefined, async () => {
            entered = true
        })).rejects.toThrow()
        expect(entered).toBe(false)
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})
