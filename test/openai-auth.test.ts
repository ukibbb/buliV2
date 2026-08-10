import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { TAuthInfo } from "@/providers/auth-store"
import { OpenAiAuthStore } from "@/providers/openai/openai-auth-store"
import { OpenAiAuth } from "@/providers/openai/openai-auth"

test("reads generic OpenAI OAuth credentials", async () => {
  await withAuthFile(
    {
      openai: {
        type: "oauth",
        access: "access-token",
        refresh: "refresh-token",
        expires: 200,
        accountId: "account-id",
      },
    },
    async (path) => {
      const store = new OpenAiAuthStore(path)
      const auth = new OpenAiAuth({ store, now: () => 100 })

      expect(await store.all()).toEqual({
        openai: {
          type: "oauth",
          access: "access-token",
          refresh: "refresh-token",
          expires: 200,
          accountId: "account-id",
        },
      })
      expect(await auth.getCredential()).toEqual({
        type: "oauth",
        access: "access-token",
        refresh: "refresh-token",
        expires: 200,
        accountId: "account-id",
      })
    },
  )
})

test("adds file OAuth credentials and rewrites Responses requests to Codex", async () => {
  await withAuthFile(
    {
      openai: {
        type: "oauth",
        access: "access-token",
        refresh: "refresh-token",
        expires: 200,
        accountId: "account-id",
      },
    },
    async (path) => {
      let capturedRequest: Request | undefined
      const captureFetch = Object.assign(
        async (...args: Parameters<typeof globalThis.fetch>) => {
          capturedRequest = new Request(...args)
          return new Response("ok")
        },
        { preconnect: globalThis.fetch.preconnect },
      )
      const auth = new OpenAiAuth({
        store: new OpenAiAuthStore(path),
        fetch: captureFetch,
        now: () => 100,
      })

      await auth.authenticatedFetch("https://api.openai.com/v1/responses", {
        method: "POST",
        body: "request-body",
        headers: {
          authorization: "Bearer sdk-placeholder",
          "x-request-id": "request-id",
        },
      })

      expect(capturedRequest?.url).toBe("https://chatgpt.com/backend-api/codex/responses")
      expect(capturedRequest?.method).toBe("POST")
      expect(await capturedRequest?.text()).toBe("request-body")
      expect(capturedRequest?.headers.get("authorization")).toBe("Bearer access-token")
      expect(capturedRequest?.headers.get("ChatGPT-Account-Id")).toBe("account-id")
      expect(capturedRequest?.headers.get("originator")).toBe("opencode")
      expect(capturedRequest?.headers.get("x-request-id")).toBe("request-id")
    },
  )
})

test("rejects API key credentials", async () => {
  await withAuthText(
    JSON.stringify({ openai: { type: "api", key: "api-key" } }),
    async (path) => {
      const store = new OpenAiAuthStore(path)

      await expect(store.get("openai")).rejects.toThrow(
        "only OAuth credentials are supported",
      )
    },
  )
})

test("rejects missing credentials without making a request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "buli-auth-test-"))
  const path = join(directory, "missing-auth.json")
  let requests = 0
  const captureFetch = Object.assign(
    async () => {
      requests += 1
      return new Response("ok")
    },
    { preconnect: globalThis.fetch.preconnect },
  ) as typeof globalThis.fetch

  try {
    const missing = new OpenAiAuth({
      store: new OpenAiAuthStore(path),
      fetch: captureFetch,
    })
    await expect(
      missing.authenticatedFetch("https://api.openai.com/v1/responses"),
    ).rejects.toThrow("OpenAI authentication is missing")

    expect(requests).toBe(0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("refreshes expired OAuth credentials and persists the canonical schema", async () => {
  const directory = await mkdtemp(join(tmpdir(), "buli-auth-test-"))
  const path = join(directory, "auth.json")
  await Bun.write(path, JSON.stringify({
    openai: {
      type: "oauth",
      access: "expired-access-token",
      refresh: "old-refresh-token",
      expires: 100,
      accountId: "account-id",
    },
  }))
  const requests: Request[] = []
  const captureFetch = Object.assign(
    async (...args: Parameters<typeof globalThis.fetch>) => {
      const request = new Request(...args)
      requests.push(request)
      if (request.url === "https://auth.openai.com/oauth/token") {
        return Response.json({
          access_token: "refreshed-access-token",
          refresh_token: "refreshed-refresh-token",
          expires_in: 3600,
        })
      }
      return new Response("ok")
    },
    { preconnect: globalThis.fetch.preconnect },
  )

  try {
    const auth = new OpenAiAuth({
      store: new OpenAiAuthStore(path),
      fetch: captureFetch,
      now: () => 100,
    })

    await auth.authenticatedFetch("https://api.openai.com/v1/responses", {
      method: "POST",
      body: "request-body",
    })

    expect(requests).toHaveLength(2)
    expect(await requests[0]?.text()).toContain("refresh_token=old-refresh-token")
    expect(requests[1]?.headers.get("authorization")).toBe(
      "Bearer refreshed-access-token",
    )
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      openai: {
        type: "oauth",
        access: "refreshed-access-token",
        refresh: "refreshed-refresh-token",
        expires: 3_600_100,
        accountId: "account-id",
      },
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("writes canonical OAuth credentials with private permissions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "buli-auth-test-"))
  const path = join(directory, "nested", "auth.json")
  const store = new OpenAiAuthStore(path)

  try {
    await store.set("openai", {
      type: "oauth",
      access: "access-token",
      refresh: "refresh-token",
      expires: 200,
    })

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      openai: {
        type: "oauth",
        access: "access-token",
        refresh: "refresh-token",
        expires: 200,
      },
    })
    expect((await stat(join(directory, "nested"))).mode & 0o777).toBe(0o700)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("rejects malformed authentication files", async () => {
  await withAuthText("not json", async (path) => {
    const store = new OpenAiAuthStore(path)
    await expect(store.all()).rejects.toThrow("Unable to read authentication")
  })
})

async function withAuthFile(
  value: Record<string, TAuthInfo>,
  run: (path: string) => Promise<void>,
): Promise<void> {
  return withAuthText(JSON.stringify(value), run)
}

async function withAuthText(
  text: string,
  run: (path: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "buli-auth-test-"))
  const path = join(directory, "auth.json")

  try {
    await Bun.write(path, text)
    await run(path)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
