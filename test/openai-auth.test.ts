import { expect, test } from "bun:test"
import { Buffer } from "node:buffer"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { FileAuthStore } from "@/auth/file-auth-store"
import type {
  IAuthStore,
  IOAuthCredential,
  TAuthCredential,
} from "@/auth/types"
import { OpenAiAuth } from "@/providers/openai/openai-auth"
import {
  OPENAI_CODEX_RESPONSES_URL,
  OPENAI_OAUTH_CALLBACK_URL,
  OPENAI_OAUTH_TOKEN_URL,
} from "@/providers/openai/openai-constants"
import { OpenAiOAuth } from "@/providers/openai/openai-oauth"

test("reports and reads an existing OpenAI OAuth credential", async () => {
  await withStore(async (store) => {
    await store.set("openai", {
      type: "oauth",
      access: "access-token",
      refresh: "refresh-token",
      expires: 1_000_000,
      accountId: "account-id",
    })
    const auth = new OpenAiAuth({ store, now: () => 100 })

    expect(await auth.getCredential()).toEqual({
      type: "oauth",
      access: "access-token",
      refresh: "refresh-token",
      expires: 1_000_000,
      accountId: "account-id",
    })
    expect(await auth.status()).toEqual({
      providerId: "openai",
      connected: true,
      expiresAt: 1_000_000,
      accountId: "account-id",
    })
  })
})

test("rejects missing credentials with an actionable login command", async () => {
  await withStore(async (store) => {
    const auth = new OpenAiAuth({ store })

    await expect(auth.requireCredential()).rejects.toThrow(
      "OpenAI is not connected. Run `buli login`.",
    )
    expect(await auth.status()).toEqual({
      providerId: "openai",
      connected: false,
    })
  })
})

test("refreshes inside the five-minute skew and persists rotated tokens", async () => {
  await withStore(async (store, path) => {
    await store.set("anthropic", {
      type: "api_key",
      key: "anthropic-key",
    })
    await store.set("openai", {
      type: "oauth",
      access: "old-access",
      refresh: "old-refresh",
      expires: 200,
      accountId: "account-id",
    })
    const requests: Request[] = []
    const auth = new OpenAiAuth({
      store,
      now: () => 100,
      fetch: fetchImplementation(async (...args) => {
        const request = new Request(...args)
        requests.push(request)
        if (request.url !== OPENAI_OAUTH_TOKEN_URL) {
          throw new Error(`Unexpected request: ${request.url}`)
        }
        return Response.json({
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 3600,
        })
      }),
    })

    const [first, second] = await Promise.all([
      auth.requireCredential(),
      auth.requireCredential(),
    ])

    expect(first).toEqual(second)
    expect(requests).toHaveLength(1)
    expect(await requests[0]?.text()).toContain("refresh_token=old-refresh")
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      openai: {
        type: "oauth",
        access: "new-access",
        refresh: "new-refresh",
        expires: 3_600_100,
        accountId: "account-id",
      },
      anthropic: {
        type: "api_key",
        key: "anthropic-key",
      },
      $buli: { authOperations: { anthropic: 1, openai: 1 } },
    })
  })
})

test("backfills an account ID from a valid stored access token", async () => {
  await withStore(async (store) => {
    await store.set("openai", {
      type: "oauth",
      access: jwt({
        "https://api.openai.com/auth": {
          chatgpt_account_id: "jwt-account",
        },
      }),
      refresh: "refresh-token",
      expires: 1_000_000,
    })
    const auth = new OpenAiAuth({ store, now: () => 100 })

    expect((await auth.requireCredential()).accountId).toBe("jwt-account")
    expect((await auth.getCredential())?.accountId).toBe("jwt-account")
  })
})

test("account backfill preserves a concurrently rotated credential", async () => {
  await withStore(async (store) => {
    const access = jwt({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "jwt-account",
      },
    })
    await store.set("openai", {
      type: "oauth",
      access,
      refresh: "old-refresh",
      expires: 1_000_000,
    })
    let injectConcurrentRotation = true
    const racingStore: IAuthStore = {
      get: (...args) => store.get(...args),
      set: (...args) => store.set(...args),
      remove: (...args) => store.remove(...args),
      modify: (providerId, update, signal) => store.modify(
        providerId,
        async (current) => {
          if (
            injectConcurrentRotation
            && current?.type === "oauth"
          ) {
            injectConcurrentRotation = false
            return update({
              ...current,
              refresh: "rotated-refresh",
              expires: 2_000_000,
            })
          }
          return update(current)
        },
        signal,
      ),
      beginOperation: (...args) => store.beginOperation(...args),
      commitOperation: (...args) => store.commitOperation(...args),
    }
    const auth = new OpenAiAuth({ store: racingStore, now: () => 100 })

    expect(await auth.requireCredential()).toMatchObject({
      accountId: "jwt-account",
      refresh: "rotated-refresh",
      expires: 2_000_000,
    })
    expect(await store.get("openai")).toMatchObject({
      accountId: "jwt-account",
      refresh: "rotated-refresh",
      expires: 2_000_000,
    })
  })
})

test("OpenAI rejects an API key credential stored under its provider ID", async () => {
  await withStore(async (store) => {
    await store.set("openai", { type: "api_key", key: "platform-key" })
    const auth = new OpenAiAuth({ store })

    await expect(auth.requireCredential()).rejects.toThrow(
      "OpenAI / ChatGPT requires an OAuth credential",
    )
  })
})

test("logout removes only the OpenAI credential and is idempotent", async () => {
  await withStore(async (store) => {
    await store.set("openai", {
      type: "oauth",
      access: "access-token",
      refresh: "refresh-token",
      expires: 1_000_000,
      accountId: "account-id",
    })
    const auth = new OpenAiAuth({ store })
    const signal = new AbortController().signal

    expect(await auth.logout(signal)).toBe(true)
    expect(await auth.logout(signal)).toBe(false)
    expect(await auth.getCredential()).toBeUndefined()
  })
})

test("browser login persists the OAuth result through the shared auth facade", async () => {
  await withStore(async (store) => {
    let authorizationUrl: string | undefined
    const oauth = new OpenAiOAuth({
      now: () => 100,
      callbackFactory: async () => {
        throw new Error("callback unavailable in test")
      },
      fetch: async (input) => {
        expect(String(input)).toBe(OPENAI_OAUTH_TOKEN_URL)
        return Response.json({
          access_token: jwt({ chatgpt_account_id: "login-account" }),
          refresh_token: "login-refresh",
          expires_in: 3600,
        })
      },
    })
    const auth = new OpenAiAuth({ store, oauth, now: () => 100 })

    const status = await auth.login("browser", {
      signal: new AbortController().signal,
      notify: (event) => {
        if (event.type === "authorization") authorizationUrl = event.url
      },
      prompt: async () => {
        const state = new URL(requireValue(authorizationUrl)).searchParams
          .get("state")
        return `${OPENAI_OAUTH_CALLBACK_URL}?code=login-code&state=${requireValue(state)}`
      },
    })

    expect(status).toEqual({
      providerId: "openai",
      connected: true,
      expiresAt: 3_600_100,
      accountId: "login-account",
    })
    expect(await store.get("openai")).toEqual({
      type: "oauth",
      access: expect.any(String),
      refresh: "login-refresh",
      expires: 3_600_100,
      accountId: "login-account",
    })
  })
})

test("browser login repairs one malformed OpenAI provider record", async () => {
  await withStore(async (store, path) => {
    await store.set("openai", {
      type: "oauth",
      access: "old-access",
      refresh: "old-refresh",
      expires: 1,
    })
    await Bun.write(path, JSON.stringify({
      openai: { type: "oauth", access: 42, refresh: null, expires: "later" },
      other: { type: "future", value: true },
    }))
    const auth = new OpenAiAuth({ store, oauth: loginOAuth() })

    await expect(startBrowserLogin(auth)).resolves.toMatchObject({
      connected: true,
      accountId: "login-account",
    })
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      openai: {
        type: "oauth",
        access: expect.any(String),
        refresh: "login-refresh",
        expires: expect.any(Number),
        accountId: "login-account",
      },
      other: { type: "future", value: true },
      $buli: { authOperations: { openai: 1 } },
    })
  })
})

test("refuses to replay an unauthorized request under a different account", async () => {
  await withStore(async (store) => {
    await store.set("openai", {
      type: "oauth",
      access: "new-account-token",
      refresh: "new-account-refresh",
      expires: 1_000_000,
      accountId: "account-b",
    })
    const auth = new OpenAiAuth({ store, now: () => 100 })

    await expect(auth.refreshAfterUnauthorized(
      "observed-account-a-token",
      "account-a",
    )).rejects.toThrow("account changed")
  })
})

test("logout prevents an in-flight login from committing afterward", async () => {
  const store = new LoginGateStore()
  const auth = new OpenAiAuth({ store, oauth: loginOAuth() })
  const login = startBrowserLogin(auth)

  await store.modifyStarted.promise
  const logout = auth.logout(new AbortController().signal)
  store.allowModify.resolve()

  await expect(login).rejects.toThrow("login was replaced")
  await logout
  expect(await store.get("openai")).toBeUndefined()
})

test("a concurrent external logout blocks replacement of an existing credential", async () => {
  const store = new LoginGateStore({
    type: "oauth",
    access: "existing-access",
    refresh: "existing-refresh",
    expires: 1_000_000,
    accountId: "login-account",
  })
  const auth = new OpenAiAuth({ store, oauth: loginOAuth() })
  const login = startBrowserLogin(auth)

  await store.modifyStarted.promise
  await store.remove("openai")
  store.allowModify.resolve()

  await expect(login).rejects.toThrow("login was replaced")
  expect(await store.get("openai")).toBeUndefined()
})

test("a pre-aborted 401 retry does not start a background refresh", async () => {
  await withStore(async (store) => {
    let requests = 0
    const auth = new OpenAiAuth({
      store,
      fetch: fetchImplementation(async () => {
        requests += 1
        return new Response(null, { status: 500 })
      }),
    })
    const controller = new AbortController()
    controller.abort(new Error("request cancelled"))

    await expect(auth.refreshAfterUnauthorized(
      "access-token",
      "account-id",
      controller.signal,
    )).rejects.toThrow("request cancelled")
    expect(requests).toBe(0)
  })
})

test("an aborted login cannot enter the credential commit", async () => {
  const store = new LoginGateStore()
  const auth = new OpenAiAuth({ store, oauth: loginOAuth() })
  const controller = new AbortController()
  const login = startBrowserLogin(auth, controller.signal)

  await store.modifyStarted.promise
  const cancellation = new Error("login cancelled before commit")
  controller.abort(cancellation)
  store.allowModify.resolve()

  await expect(login).rejects.toBe(cancellation)
  expect(store.commitSignal?.aborted).toBe(true)
  expect(await store.get("openai")).toBeUndefined()
})

test("dispose waits for an active browser login to abort and clean up", async () => {
  await withStore(async (store) => {
    const authorizationShown = Promise.withResolvers<void>()
    const shutdownReason = new Error("test shutdown")
    let beginOperationCount = 0
    const countingStore: IAuthStore = {
      get: (...args) => store.get(...args),
      set: (...args) => store.set(...args),
      remove: (...args) => store.remove(...args),
      modify: (...args) => store.modify(...args),
      beginOperation: (...args) => {
        beginOperationCount += 1
        return store.beginOperation(...args)
      },
      commitOperation: (...args) => store.commitOperation(...args),
    }
    let promptSignal: AbortSignal | undefined
    let reentrantDispose: Promise<void> | undefined
    let reentrantLoginFailure: Promise<unknown> | undefined
    const auth = new OpenAiAuth({ store: countingStore, oauth: loginOAuth() })
    const login = auth.login("browser", {
      signal: new AbortController().signal,
      notify: (event) => {
        if (event.type === "authorization") authorizationShown.resolve()
      },
      prompt: (request) => {
        promptSignal = request.signal
        return new Promise<string>((_resolve, reject) => {
          request.signal.addEventListener("abort", () => {
            reentrantDispose = auth.dispose(new Error("reentrant shutdown"))
            reentrantLoginFailure = auth.login("browser", {
              signal: new AbortController().signal,
              notify: () => {},
              prompt: async () => "unused",
            }).catch((error: unknown) => error)
            reject(request.signal.reason)
          }, { once: true })
        })
      },
    })
    const loginFailure = login.catch((error: unknown) => error)

    await authorizationShown.promise
    while (!promptSignal) await Promise.resolve()
    const firstDispose = auth.dispose(shutdownReason)
    const secondDispose = auth.dispose(new Error("ignored shutdown"))

    expect(reentrantDispose).toBe(firstDispose)
    expect(secondDispose).toBe(firstDispose)
    await firstDispose
    expect(auth.dispose()).toBe(firstDispose)
    if (!reentrantLoginFailure) throw new Error("Reentrant login was not attempted")
    expect(await reentrantLoginFailure).toBe(shutdownReason)
    // Abort zamyka bramkę przed callbackiem, więc reentrant login nie dotyka store.
    expect(beginOperationCount).toBe(1)

    expect(promptSignal?.aborted).toBe(true)
    await expect(loginFailure).resolves.toMatchObject({ message: "test shutdown" })
  })
})

test("dispose aborts and waits for a direct logout store operation", async () => {
  await withStore(async (store) => {
    const removeStarted = Promise.withResolvers<AbortSignal | undefined>()
    const finishRemove = Promise.withResolvers<void>()
    const trackedStore: IAuthStore = {
      get: (...args) => store.get(...args),
      set: (...args) => store.set(...args),
      remove: async (...args) => {
        removeStarted.resolve(args[1])
        await finishRemove.promise
        args[1]?.throwIfAborted()
        return store.remove(...args)
      },
      modify: (...args) => store.modify(...args),
      beginOperation: (...args) => store.beginOperation(...args),
      commitOperation: (...args) => store.commitOperation(...args),
    }
    const auth = new OpenAiAuth({ store: trackedStore })
    const logoutFailure = auth.logout(
      new AbortController().signal,
    ).catch((error: unknown) => error)
    const operationSignal = await removeStarted.promise
    const shutdownReason = new Error("provider shutdown")
    let disposeFinished = false
    const disposal = auth.dispose(shutdownReason).then(() => {
      disposeFinished = true
    })

    expect(operationSignal?.aborted).toBe(true)
    await Promise.resolve()
    expect(disposeFinished).toBe(false)

    finishRemove.resolve()
    await disposal
    expect(await logoutFailure).toBe(shutdownReason)
  })
})

test("dispose waits for an account-ID backfill operation", async () => {
  await withStore(async (store) => {
    await store.set("openai", {
      type: "oauth",
      access: jwt({
        "https://api.openai.com/auth": {
          chatgpt_account_id: "jwt-account",
        },
      }),
      refresh: "refresh-token",
      expires: 1_000_000,
    })
    const modifyStarted = Promise.withResolvers<AbortSignal | undefined>()
    const finishModify = Promise.withResolvers<void>()
    const trackedStore: IAuthStore = {
      get: (...args) => store.get(...args),
      set: (...args) => store.set(...args),
      remove: (...args) => store.remove(...args),
      modify: async (providerId, update, signal) => {
        modifyStarted.resolve(signal)
        await finishModify.promise
        signal?.throwIfAborted()
        return store.modify(providerId, update, signal)
      },
      beginOperation: (...args) => store.beginOperation(...args),
      commitOperation: (...args) => store.commitOperation(...args),
    }
    const auth = new OpenAiAuth({ store: trackedStore, now: () => 100 })
    const credentialFailure = auth.requireCredential().catch(
      (error: unknown) => error,
    )
    const operationSignal = await modifyStarted.promise
    const shutdownReason = new Error("backfill shutdown")
    let disposeFinished = false
    const disposal = auth.dispose(shutdownReason).then(() => {
      disposeFinished = true
    })

    expect(operationSignal?.aborted).toBe(true)
    await Promise.resolve()
    expect(disposeFinished).toBe(false)

    finishModify.resolve()
    await disposal
    expect(await credentialFailure).toBe(shutdownReason)
  })
})

test("disposed authentication cannot send a stored bearer token", async () => {
  await withStore(async (store) => {
    await store.set("openai", {
      type: "oauth",
      access: "access-token",
      refresh: "refresh-token",
      expires: 1_000_000,
      accountId: "account-id",
    })
    let requests = 0
    const auth = new OpenAiAuth({
      store,
      fetch: fetchImplementation(async () => {
        requests += 1
        return new Response("unexpected")
      }),
    })
    await auth.dispose(new Error("authentication disposed"))

    await expect(auth.authenticatedFetch(OPENAI_CODEX_RESPONSES_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })).rejects.toThrow("authentication disposed")
    expect(requests).toBe(0)
  })
})

async function withStore(
  run: (store: FileAuthStore, path: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "buli-openai-auth-"))
  const path = join(directory, "private", "auth.json")
  try {
    await run(new FileAuthStore(path), path)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

function fetchImplementation(
  run: (...args: Parameters<typeof globalThis.fetch>) => Promise<Response>,
): typeof fetch {
  return Object.assign(run, { preconnect: globalThis.fetch.preconnect })
}

function jwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
  return `${header}.${body}.signature`
}

function requireValue<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected test value")
  return value
}

function loginOAuth(): OpenAiOAuth {
  return new OpenAiOAuth({
    callbackFactory: async () => {
      throw new Error("callback unavailable in test")
    },
    fetch: async () => Response.json({
      access_token: jwt({ chatgpt_account_id: "login-account" }),
      refresh_token: "login-refresh",
      expires_in: 3600,
    }),
  })
}

function startBrowserLogin(
  auth: OpenAiAuth,
  signal: AbortSignal = new AbortController().signal,
): ReturnType<OpenAiAuth["login"]> {
  let authorizationUrl: string | undefined
  return auth.login("browser", {
    signal,
    notify: (event) => {
      if (event.type === "authorization") authorizationUrl = event.url
    },
    prompt: async () => {
      const state = new URL(requireValue(authorizationUrl)).searchParams.get("state")
      return `code=login-code&state=${requireValue(state)}`
    },
  })
}

class LoginGateStore implements IAuthStore {
  readonly modifyStarted = Promise.withResolvers<void>()
  readonly allowModify = Promise.withResolvers<void>()
  commitSignal: AbortSignal | undefined
  private credential: TAuthCredential | undefined
  private operation = 0

  constructor(credential?: IOAuthCredential) {
    this.credential = credential
  }

  async get(_providerId: string): Promise<TAuthCredential | undefined> {
    return this.credential
  }

  async set(_providerId: string, credential: TAuthCredential): Promise<void> {
    this.credential = credential
  }

  async remove(_providerId: string): Promise<boolean> {
    const existed = this.credential !== undefined
    this.credential = undefined
    this.operation += 1
    return existed
  }

  async modify(
    _providerId: string,
    update: (
      current: TAuthCredential | undefined,
    ) => Promise<TAuthCredential | undefined>,
  ): Promise<TAuthCredential | undefined> {
    this.modifyStarted.resolve()
    await this.allowModify.promise
    this.credential = await update(this.credential)
    return this.credential
  }

  async beginOperation(): Promise<number> {
    this.operation += 1
    return this.operation
  }

  async commitOperation(
    _providerId: string,
    operation: number,
    credential: TAuthCredential,
    signal?: AbortSignal,
  ): Promise<boolean> {
    this.commitSignal = signal
    this.modifyStarted.resolve()
    await this.allowModify.promise
    signal?.throwIfAborted()
    if (operation !== this.operation) return false
    this.credential = credential
    return true
  }
}
