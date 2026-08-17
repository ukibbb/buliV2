import { expect, test } from "bun:test"
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { FileAuthStore } from "@/auth/file-auth-store"
import type { IOAuthCredential, TAuthCredential } from "@/auth/types"

test("reads existing OpenAI OAuth credentials", async () => {
  await withAuthPath(async (path) => {
    const credential = oauthCredential("openai-access", {
      accountId: "account-id",
      enterpriseUrl: "https://example.test",
    })
    await writeAuth(path, { openai: credential })

    const store = new FileAuthStore(path)

    expect(await store.get("openai")).toEqual(credential)
    expect(await store.get("missing")).toBeUndefined()
  })
})

test("stores OAuth and API key credentials for different providers", async () => {
  await withAuthPath(async (path) => {
    const store = new FileAuthStore(path)
    const openai = oauthCredential("openai-access")
    const anthropic = apiKeyCredential("anthropic-key")

    await store.set("openai", openai)
    await store.set("anthropic", anthropic)

    expect(await store.get("openai")).toEqual(openai)
    expect(await store.get("anthropic")).toEqual(anthropic)
    expect(await readAuth(path)).toEqual({
      openai,
      anthropic,
      $buli: { authOperations: { openai: 1, anthropic: 1 } },
    })
  })
})

test("writes private files atomically and cleans up siblings", async () => {
  await withAuthPath(async (path) => {
    const store = new FileAuthStore(path)

    await store.set("openai", oauthCredential("access-token"))

    expect((await stat(dirname(path))).mode & 0o777).toBe(0o700)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(await readdir(dirname(path))).toEqual(["auth.json"])
  })
})

test("preserves unrelated raw provider entries", async () => {
  await withAuthPath(async (path) => {
    const unrelated = {
      type: "future-credential",
      nested: { enabled: true, values: [1, "two", null] },
    }
    await writeAuth(path, {
      legacy: unrelated,
      count: 3,
    })

    await new FileAuthStore(path).set(
      "openai",
      oauthCredential("openai-access"),
    )

    expect(await readAuth(path)).toEqual({
      legacy: unrelated,
      count: 3,
      openai: oauthCredential("openai-access"),
      $buli: { authOperations: { openai: 1 } },
    })
  })
})

test("tolerates malformed unrelated entries while reading and modifying", async () => {
  await withAuthPath(async (path) => {
    const malformed = {
      type: "oauth",
      access: 42,
      refresh: null,
      expires: "later",
    }
    await writeAuth(path, {
      broken: malformed,
      openai: oauthCredential("old-access"),
    })
    const store = new FileAuthStore(path)

    expect(requireOAuth(await store.get("openai")).access).toBe("old-access")
    await expect(store.get("broken")).rejects.toThrow("Invalid OAuth credential")

    const updated = await store.modify("openai", async (current) => {
      if (!current) throw new Error("Expected an OpenAI credential")
      return { ...requireOAuth(current), access: "new-access" }
    })

    expect(requireOAuth(updated).access).toBe("new-access")
    expect(await readAuth(path)).toEqual({
      broken: malformed,
      openai: {
        ...oauthCredential("old-access"),
        access: "new-access",
      },
    })
  })
})

test("modify can replace a malformed credential for the requested provider", async () => {
  await withAuthPath(async (path) => {
    await writeAuth(path, {
      openai: { type: "oauth", access: 42, refresh: null, expires: "later" },
      other: { type: "future", value: true },
    })
    const store = new FileAuthStore(path)

    await store.modify("openai", async (current) => {
      expect(current).toBeUndefined()
      return oauthCredential("repaired-access")
    })

    expect(await readAuth(path)).toEqual({
      openai: oauthCredential("repaired-access"),
      other: { type: "future", value: true },
    })
  })
})

test("remove is idempotent and preserves other providers", async () => {
  await withAuthPath(async (path) => {
    await writeAuth(path, {
      openai: oauthCredential("openai-access"),
      anthropic: apiKeyCredential("anthropic-key"),
    })
    const store = new FileAuthStore(path)

    expect(await store.remove("openai")).toBe(true)
    expect(await store.remove("openai")).toBe(false)
    expect(await readAuth(path)).toEqual({
      anthropic: apiKeyCredential("anthropic-key"),
      $buli: { authOperations: { openai: 2 } },
    })
  })
})

test("logout invalidates an in-flight login across store instances", async () => {
  await withAuthPath(async (path) => {
    const loginStore = new FileAuthStore(path)
    const logoutStore = new FileAuthStore(path)
    const operation = await loginStore.beginOperation("openai")

    expect(await logoutStore.remove("openai")).toBe(false)
    expect(await loginStore.commitOperation(
      "openai",
      operation,
      oauthCredential("late-login"),
    )).toBe(false)
    expect(await loginStore.get("openai")).toBeUndefined()
  })
})

test("never overwrites malformed or non-object top-level JSON", async () => {
  await withAuthPath(async (path) => {
    await mkdir(dirname(path), { recursive: true })
    for (const text of ["not json", "[]", "null"]) {
      await writeFile(path, text, "utf8")
      const store = new FileAuthStore(path)

      await expect(store.get("openai")).rejects.toThrow(
        "Unable to read authentication",
      )
      await expect(
        store.set("openai", oauthCredential("new-access")),
      ).rejects.toThrow("Unable to read authentication")
      expect(await readFile(path, "utf8")).toBe(text)
    }
  })
})

test("serializes concurrent stores without losing provider updates", async () => {
  await withAuthPath(async (path) => {
    const first = new FileAuthStore(path)
    const second = new FileAuthStore(path)

    await Promise.all([
      first.set("provider-a", oauthCredential("access-a")),
      second.set("provider-b", oauthCredential("access-b")),
    ])

    expect(await readAuth(path)).toEqual({
      "provider-a": oauthCredential("access-a"),
      "provider-b": oauthCredential("access-b"),
      $buli: { authOperations: { "provider-a": 1, "provider-b": 1 } },
    })
  })
})

test("modify holds the lock and gives later updaters the latest credential", async () => {
  await withAuthPath(async (path) => {
    const first = new FileAuthStore(path)
    const second = new FileAuthStore(path)
    await first.set("openai", oauthCredential("original"))
    const firstStarted = Promise.withResolvers<void>()
    const finishFirst = Promise.withResolvers<void>()

    const firstUpdate = first.modify("openai", async (current) => {
      firstStarted.resolve()
      await finishFirst.promise
      if (!current) throw new Error("Expected an OpenAI credential")
      return { ...requireOAuth(current), access: "first-update" }
    })
    await firstStarted.promise

    let secondSaw: string | undefined
    const secondUpdate = second.modify("openai", async (current) => {
      secondSaw = current?.type === "oauth" ? current.access : undefined
      return current
    })
    finishFirst.resolve()

    await Promise.all([firstUpdate, secondUpdate])
    expect(secondSaw).toBe("first-update")
    expect(requireOAuth(await first.get("openai")).access).toBe("first-update")
  })
})

test("rejects unsafe provider IDs and invalid credential fields", async () => {
  await withAuthPath(async (path) => {
    const store = new FileAuthStore(path)
    const credential = oauthCredential("access")

    for (const providerId of ["", "../openai", "openai/provider", "constructor"]) {
      await expect(store.set(providerId, credential)).rejects.toThrow(
        "Invalid authentication provider ID",
      )
    }

    await expect(
      store.set(
        "openai",
        { ...credential, type: "api" } as unknown as TAuthCredential,
      ),
    ).rejects.toThrow("Unsupported credential type")

    const invalidOAuthCredentials: unknown[] = [
      { ...credential, access: "" },
      { ...credential, refresh: "" },
      { ...credential, expires: -1 },
      { ...credential, expires: Number.POSITIVE_INFINITY },
      { ...credential, accountId: "" },
      { ...credential, enterpriseUrl: "" },
    ]
    for (const invalid of invalidOAuthCredentials) {
      await expect(
        store.set("openai", invalid as TAuthCredential),
      ).rejects.toThrow("Invalid OAuth credential")
    }
    await expect(store.set("anthropic", {
      type: "api_key",
      key: "",
    })).rejects.toThrow("Invalid API key credential")
  })
})

function oauthCredential(
  access: string,
  optional: Pick<IOAuthCredential, "accountId" | "enterpriseUrl"> = {},
): IOAuthCredential {
  return {
    type: "oauth",
    access,
    refresh: `${access}-refresh`,
    expires: 1_800_000_000_000,
    ...optional,
  }
}

function apiKeyCredential(key: string): TAuthCredential {
  return { type: "api_key", key }
}

function requireOAuth(
  credential: TAuthCredential | undefined,
): IOAuthCredential {
  if (!credential || credential.type !== "oauth") {
    throw new Error("Expected an OAuth credential")
  }
  return credential
}

async function withAuthPath(
  run: (path: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "buli-file-auth-"))
  const path = join(root, "private", "auth.json")

  try {
    await run(path)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function writeAuth(
  path: string,
  value: Record<string, unknown>,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(value), "utf8")
}

async function readAuth(path: string): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"))
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Expected an authentication object")
  }
  return value as Record<string, unknown>
}
