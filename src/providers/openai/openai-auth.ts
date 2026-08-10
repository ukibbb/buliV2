import {
  defaultAuthFilePath,
  type IAuthStore,
  type TAuthInfo,
} from "@/providers/auth-store"
import { OpenAiAuthStore } from "@/providers/openai/openai-auth-store"
import {
  OPENAI_CODEX_RESPONSES_URL,
  OPENAI_OAUTH_CLIENT_ID,
  OPENAI_OAUTH_ISSUER,
} from "@/providers/openai/openai-constants"

export interface OpenAiAuthOptions {
  store?: IAuthStore
  fetch?: typeof fetch
  now?: () => number
}

/** Reads existing Buli credentials and authenticates OpenAI SDK requests. */
export class OpenAiAuth {
  private readonly store: IAuthStore
  private readonly rawFetch: typeof fetch
  private readonly now: () => number
  private refreshFlight: Promise<TAuthInfo> | undefined
  readonly authenticatedFetch: typeof fetch

  constructor(options: OpenAiAuthOptions = {}) {
    this.store = options.store ?? new OpenAiAuthStore(defaultAuthFilePath())
    this.rawFetch = options.fetch ?? globalThis.fetch
    this.now = options.now ?? Date.now
    this.authenticatedFetch = Object.assign(
      (...args: Parameters<typeof globalThis.fetch>) => this.fetchAuthenticated(...args),
      { preconnect: this.rawFetch.preconnect },
    )
  }

  async getCredential(): Promise<TAuthInfo | undefined> {
    return this.store.get("openai")
  }

  private async fetchAuthenticated(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const request = new Request(input, init)
    const credential = await this.requireCredential(request.signal)
    const headers = new Headers(request.headers)

    headers.delete("authorization")
    headers.delete("ChatGPT-Account-Id")
    headers.set("authorization", `Bearer ${credential.access}`)
    headers.set("originator", "opencode")
    if (credential.accountId) {
      headers.set("ChatGPT-Account-Id", credential.accountId)
    }

    const originalUrl = new URL(request.url)
    const shouldRewrite = originalUrl.pathname.includes("/v1/responses")
      || originalUrl.pathname.includes("/chat/completions")
    const target = shouldRewrite
      ? new URL(OPENAI_CODEX_RESPONSES_URL)
      : originalUrl
    const mayHaveBody = request.method !== "GET" && request.method !== "HEAD"
    const body = mayHaveBody ? await request.arrayBuffer() : undefined

    return this.rawFetch(target, {
      method: request.method,
      headers,
      ...(body === undefined ? {} : { body }),
      signal: request.signal,
    })
  }

  async requireCredential(signal?: AbortSignal): Promise<TAuthInfo> {
    const credential = await this.getCredential()
    if (!credential) throw new Error("OpenAI authentication is missing")
    if (credential.expires <= this.now()) return this.refreshCredential(credential, signal)

    return credential
  }

  private refreshCredential(
    credential: TAuthInfo,
    signal?: AbortSignal,
  ): Promise<TAuthInfo> {
    if (this.refreshFlight) return this.refreshFlight

    this.refreshFlight = (async () => {
      const response = await this.rawFetch(`${OPENAI_OAUTH_ISSUER}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: credential.refresh,
          client_id: OPENAI_OAUTH_CLIENT_ID,
        }).toString(),
        ...(signal ? { signal } : {}),
      })
      if (!response.ok) {
        throw new Error(`OpenAI token refresh failed: ${response.status}`)
      }

      const tokens = parseTokenResponse(await response.json())
      const refreshed: TAuthInfo = {
        type: "oauth",
        access: tokens.access_token,
        refresh: tokens.refresh_token ?? credential.refresh,
        expires: this.now() + (tokens.expires_in ?? 3600) * 1000,
        ...(credential.accountId ? { accountId: credential.accountId } : {}),
        ...(credential.enterpriseUrl
          ? { enterpriseUrl: credential.enterpriseUrl }
          : {}),
      }
      await this.store.set("openai", refreshed)
      return refreshed
    })().finally(() => {
      this.refreshFlight = undefined
    })

    return this.refreshFlight
  }
}

interface IOpenAiTokenResponse {
  access_token: string
  refresh_token?: string
  expires_in?: number
}

function parseTokenResponse(value: unknown): IOpenAiTokenResponse {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("OpenAI token refresh returned an invalid response")
  }

  const tokens = value as Record<string, unknown>
  if (typeof tokens.access_token !== "string" || !tokens.access_token) {
    throw new Error("OpenAI token refresh returned an invalid access token")
  }
  if (
    tokens.refresh_token !== undefined
    && (typeof tokens.refresh_token !== "string" || !tokens.refresh_token)
  ) {
    throw new Error("OpenAI token refresh returned an invalid refresh token")
  }
  if (
    tokens.expires_in !== undefined
    && (
      typeof tokens.expires_in !== "number"
      || !Number.isFinite(tokens.expires_in)
      || tokens.expires_in <= 0
    )
  ) {
    throw new Error("OpenAI token refresh returned an invalid expiration")
  }

  return {
    access_token: tokens.access_token,
    ...(typeof tokens.refresh_token === "string"
      ? { refresh_token: tokens.refresh_token }
      : {}),
    ...(typeof tokens.expires_in === "number"
      ? { expires_in: tokens.expires_in }
      : {}),
  }
}
