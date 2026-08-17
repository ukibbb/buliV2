import { afterEach, expect, jest, test } from "bun:test"
import { Buffer } from "node:buffer"

import type { IAuthInteraction, TAuthEvent } from "@/auth/contracts"
import type { IOAuthCredential } from "@/auth/types"
import {
    OPENAI_OAUTH_AUTHORIZE_URL,
    OPENAI_OAUTH_CALLBACK_URL,
    OPENAI_OAUTH_CLIENT_ID,
    OPENAI_OAUTH_DEVICE_AUTHORIZATION_URL,
    OPENAI_OAUTH_DEVICE_REDIRECT_URL,
    OPENAI_OAUTH_DEVICE_TOKEN_URL,
    OPENAI_OAUTH_DEVICE_USER_CODE_URL,
    OPENAI_OAUTH_ORIGINATOR,
    OPENAI_OAUTH_TOKEN_URL,
} from "@/providers/openai/openai-constants"
import {
    escapeOpenAiOAuthHtml,
    renderOpenAiOAuthCallbackHtml,
    startOpenAiOAuthCallback,
} from "@/providers/openai/openai-oauth-callback"
import {
    createOpenAiAuthorizationRequest,
    extractOpenAiAccountId,
    OpenAiOAuth,
    parseOpenAiManualCallback,
    parseOpenAiTokenResponse,
    type TOpenAiOAuthFetch,
} from "@/providers/openai/openai-oauth"

afterEach(() => {
    if (jest.isFakeTimers()) jest.useRealTimers()
})

test("builds the pinned OpenAI browser authorization request with 32-byte PKCE", async () => {
    const authorization = await createOpenAiAuthorizationRequest()
    const url = new URL(authorization.url)
    const expectedChallenge = Buffer.from(await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(authorization.verifier),
    )).toString("base64url")

    expect(`${url.origin}${url.pathname}`).toBe(OPENAI_OAUTH_AUTHORIZE_URL)
    expect(Buffer.from(authorization.verifier, "base64url")).toHaveLength(32)
    expect(Buffer.from(authorization.state, "base64url")).toHaveLength(32)
    expect(authorization.challenge).toBe(expectedChallenge)
    expect(Object.fromEntries(url.searchParams)).toEqual({
        response_type: "code",
        client_id: OPENAI_OAUTH_CLIENT_ID,
        redirect_uri: OPENAI_OAUTH_CALLBACK_URL,
        scope: "openid profile email offline_access",
        code_challenge: expectedChallenge,
        code_challenge_method: "S256",
        state: authorization.state,
        id_token_add_organizations: "true",
        codex_cli_simplified_flow: "true",
        originator: OPENAI_OAUTH_ORIGINATOR,
    })
})

test("validates token fields and selects ChatGPT account claims without organization fallback", () => {
    const tokens = parseOpenAiTokenResponse({
        access_token: jwt({
            "https://api.openai.com/auth": {
                chatgpt_account_id: "same-account",
            },
        }),
        id_token: jwt({ chatgpt_account_id: "same-account" }),
        refresh_token: "refresh-token",
        expires_in: 3600,
    }, { requireRefreshToken: true })

    expect(extractOpenAiAccountId(tokens)).toBe("same-account")
    expect(() => extractOpenAiAccountId({
        access_token: jwt({ chatgpt_account_id: "access-account" }),
        id_token: jwt({ chatgpt_account_id: "id-account" }),
    })).toThrow("conflicting account IDs")
    expect(extractOpenAiAccountId({
        access_token: jwt({
            "https://api.openai.com/auth": {
                chatgpt_account_id: "nested-account",
            },
        }),
    })).toBe("nested-account")
    expect(extractOpenAiAccountId({
        access_token: jwt({ organizations: [{ id: "organization-id" }] }),
    })).toBeUndefined()
    expect(() => parseOpenAiTokenResponse({
        access_token: "access-token",
        refresh_token: "refresh-token",
        expires_in: 1.5,
    })).toThrow("invalid expiration")
    expect(() => parseOpenAiTokenResponse({
        access_token: "access-token",
        expires_in: 3600,
    }, { requireRefreshToken: true })).toThrow("did not return a refresh token")
})

test("uses strict state-bearing manual callback formats and falls back when binding fails", async () => {
    const state = "expected-state"
    expect(parseOpenAiManualCallback(
        `${OPENAI_OAUTH_CALLBACK_URL}?code=url-code&state=${state}`,
        state,
    )).toBe("url-code")
    expect(parseOpenAiManualCallback(`?code=query-code&state=${state}`, state))
        .toBe("query-code")
    expect(parseOpenAiManualCallback(`pair-code#${state}`, state)).toBe("pair-code")
    expect(() => parseOpenAiManualCallback("state-less-code", state))
        .toThrow("must include its state")
    expect(() => parseOpenAiManualCallback("code#wrong-state", state))
        .toThrow("state did not match")
    expect(() => parseOpenAiManualCallback(
        `http://127.0.0.1:1455/auth/callback?code=code&state=${state}`,
        state,
    )).toThrow("does not match the expected URL")

    const order: string[] = []
    let authorizationUrl: string | undefined
    let callbackState: string | undefined
    const oauth = new OpenAiOAuth({
        now: () => 500,
        callbackFactory: async (options) => {
            callbackState = options.expectedState
            throw new Error("port occupied")
        },
        fetch: async (input, init) => {
            expect(String(input)).toBe(OPENAI_OAUTH_TOKEN_URL)
            expect(init?.redirect).toBe("error")
            return Response.json({
                access_token: jwt({ chatgpt_account_id: "browser-account" }),
                refresh_token: "browser-refresh",
                expires_in: 60,
            })
        },
    })
    const interaction: IAuthInteraction = {
        signal: new AbortController().signal,
        notify: (event) => {
            order.push("notify")
            if (event.type === "authorization") authorizationUrl = event.url
        },
        prompt: async () => {
            order.push("prompt")
            const actualState = new URL(requireValue(authorizationUrl)).searchParams
                .get("state")
            return `code=manual-code&state=${requireValue(actualState)}`
        },
    }

    await expect(oauth.login("browser", interaction)).resolves.toEqual({
        type: "oauth",
        access: expect.any(String),
        refresh: "browser-refresh",
        expires: 60_500,
        accountId: "browser-account",
    })
    expect(callbackState).toBe(
        requireValue(
            new URL(requireValue(authorizationUrl)).searchParams.get("state"),
        ),
    )
    expect(order).toEqual(["notify", "prompt"])
})

test("loopback callback ignores wrong state and accepts one valid code", async () => {
    const controller = new AbortController()
    const callback = await startOpenAiOAuthCallback({
        expectedState: "expected-state",
        signal: controller.signal,
    })
    const waiting = callback.waitForCode()
    let settled = false
    void waiting.then(
        () => {
            settled = true
        },
        () => {
            settled = true
        },
    )

    try {
        const wrong = await fetch(
            "http://127.0.0.1:1455/auth/callback?code=wrong&state=wrong-state",
        )
        expect(wrong.status).toBe(400)
        await Promise.resolve()
        expect(settled).toBe(false)

        const accepted = await fetch(
            "http://127.0.0.1:1455/auth/callback?code=accepted-code&state=expected-state",
        )
        expect(accepted.status).toBe(200)
        expect(accepted.headers.get("cache-control")).toBe("no-store")
        expect(accepted.headers.get("content-security-policy")).toContain(
            "default-src 'none'",
        )
        expect(await waiting).toBe("accepted-code")
    } finally {
        controller.abort()
        await callback.close()
    }
})

test("completes device login after HTTP and authorization_pending responses", async () => {
    jest.useFakeTimers({ now: 0 })
    const events: TAuthEvent[] = []
    let polls = 0
    const fetcher: TOpenAiOAuthFetch = async (input, init) => {
        const url = String(input)
        expect(init?.redirect).toBe("error")

        if (url === OPENAI_OAUTH_DEVICE_USER_CODE_URL) {
            expect(JSON.parse(String(init?.body))).toEqual({
                client_id: OPENAI_OAUTH_CLIENT_ID,
            })
            return Response.json({
                device_auth_id: "device-auth-id",
                user_code: "ABCD-1234",
                interval: 0,
            })
        }
        if (url === OPENAI_OAUTH_DEVICE_TOKEN_URL) {
            polls += 1
            expect(JSON.parse(String(init?.body))).toEqual({
                device_auth_id: "device-auth-id",
                user_code: "ABCD-1234",
            })
            if (polls === 1) return Response.json({}, { status: 403 })
            if (polls === 2) {
                return Response.json({
                    error: { code: "deviceauth_authorization_pending" },
                }, { status: 400 })
            }
            return Response.json({
                authorization_code: "device-authorization-code",
                code_verifier: "device-code-verifier",
            })
        }
        if (url === OPENAI_OAUTH_TOKEN_URL) {
            const body = new URLSearchParams(String(init?.body))
            expect(body.get("code")).toBe("device-authorization-code")
            expect(body.get("code_verifier")).toBe("device-code-verifier")
            expect(body.get("redirect_uri")).toBe(OPENAI_OAUTH_DEVICE_REDIRECT_URL)
            return Response.json({
                access_token: jwt({
                    "https://api.openai.com/auth": {
                        chatgpt_account_id: "device-account",
                    },
                }),
                refresh_token: "device-refresh",
                expires_in: 3600,
            })
        }
        throw new Error(`Unexpected URL: ${url}`)
    }
    const oauth = new OpenAiOAuth({ fetch: fetcher, now: () => 100 })
    const login = oauth.login("device", {
        signal: new AbortController().signal,
        notify: (event) => {
            events.push(event)
        },
        prompt: async () => {
            throw new Error("Device login must not prompt")
        },
    })

    await flushPromises()
    expect(polls).toBe(1)
    expect(events).toEqual([{
        type: "device",
        url: OPENAI_OAUTH_DEVICE_AUTHORIZATION_URL,
        userCode: "ABCD-1234",
        instructions: "Open the URL and enter the device code.",
    }])

    jest.advanceTimersByTime(999)
    await flushPromises()
    expect(polls).toBe(1)
    jest.advanceTimersByTime(1)
    await flushPromises()
    expect(polls).toBe(2)
    jest.advanceTimersByTime(999)
    await flushPromises()
    expect(polls).toBe(2)
    jest.advanceTimersByTime(1)

    await expect(login).resolves.toEqual({
        type: "oauth",
        access: expect.any(String),
        refresh: "device-refresh",
        expires: 3_600_100,
        accountId: "device-account",
    })
    expect(polls).toBe(3)
})

test("refresh preserves omitted fields and rejects a conflicting account", async () => {
    const requests: RequestInit[] = []
    const oauth = new OpenAiOAuth({
        now: () => 10_000,
        fetch: async (input, init) => {
            expect(String(input)).toBe(OPENAI_OAUTH_TOKEN_URL)
            requests.push(init ?? {})
            return Response.json({
                access_token: "new-access-token",
                expires_in: 120,
            })
        },
    })
    const current: IOAuthCredential = {
        type: "oauth",
        access: "old-access-token",
        refresh: "old-refresh-token",
        expires: 1,
        accountId: "account-a",
        enterpriseUrl: "https://example.test",
    }

    await expect(oauth.refresh(
        current,
        new AbortController().signal,
    )).resolves.toEqual({
        type: "oauth",
        access: "new-access-token",
        refresh: "old-refresh-token",
        expires: 130_000,
        accountId: "account-a",
        enterpriseUrl: "https://example.test",
    })
    expect(requests[0]?.redirect).toBe("error")
    expect(new URLSearchParams(String(requests[0]?.body)).get("refresh_token"))
        .toBe("old-refresh-token")

    const conflicting = new OpenAiOAuth({
        fetch: async () => Response.json({
            access_token: jwt({ chatgpt_account_id: "account-b" }),
            expires_in: 120,
        }),
    })
    await expect(conflicting.refresh(
        current,
        new AbortController().signal,
    )).rejects.toThrow("conflicting account ID")
})

test("escapes callback messages before rendering safe HTML", () => {
    const unsafe = `<img src=x onerror="alert('x')"> & goodbye`
    const escaped = "&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt; &amp; goodbye"

    expect(escapeOpenAiOAuthHtml(unsafe)).toBe(escaped)
    const html = renderOpenAiOAuthCallbackHtml(unsafe, false)
    expect(html).toContain(escaped)
    expect(html).not.toContain(unsafe)
})

function jwt(payload: Record<string, unknown>): string {
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
    return `${header}.${body}.signature`
}

function requireValue<T>(value: T | null | undefined): T {
    if (value === null || value === undefined) throw new Error("Expected test value")
    return value
}

async function flushPromises(): Promise<void> {
    for (let index = 0; index < 10; index += 1) await Promise.resolve()
}
