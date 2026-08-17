import { Buffer } from "node:buffer"

import type { IAuthInteraction } from "@/auth/contracts"
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
    startOpenAiOAuthCallback,
    type IOpenAiOAuthCallback,
    type TOpenAiOAuthCallbackFactory,
} from "@/providers/openai/openai-oauth-callback"

export const OPENAI_OAUTH_BROWSER_METHOD_ID = "browser"
export const OPENAI_OAUTH_DEVICE_METHOD_ID = "device"

const OAUTH_SCOPE = "openid profile email offline_access"
const JWT_AUTH_CLAIM = "https://api.openai.com/auth"
const REMOTE_REQUEST_TIMEOUT_MS = 15_000
const BROWSER_LOGIN_TIMEOUT_MS = 5 * 60 * 1000
const DEVICE_LOGIN_TIMEOUT_MS = 15 * 60 * 1000
const DEFAULT_DEVICE_INTERVAL_MS = 5_000
const MINIMUM_DEVICE_INTERVAL_MS = 1_000
const SLOW_DOWN_INCREMENT_MS = 5_000

export type TOpenAiOAuthFetch = (
    input: RequestInfo | URL,
    init?: RequestInit,
) => Promise<Response>

export interface IOpenAiOAuthOptions {
    readonly fetch?: TOpenAiOAuthFetch
    readonly now?: () => number
    readonly callbackFactory?: TOpenAiOAuthCallbackFactory
}

export interface IOpenAiAuthorizationRequest {
    readonly verifier: string
    readonly challenge: string
    readonly state: string
    readonly url: string
}

export interface IOpenAiOAuthTokenResponse {
    readonly access_token: string
    readonly refresh_token?: string
    readonly id_token?: string
    readonly expires_in: number
}

/** Implements the fixed ChatGPT/Codex browser and device OAuth protocols. */
export class OpenAiOAuth {
    private readonly fetcher: TOpenAiOAuthFetch
    private readonly now: () => number
    private readonly callbackFactory: TOpenAiOAuthCallbackFactory

    constructor(options: IOpenAiOAuthOptions = {}) {
        this.fetcher = options.fetch ?? globalThis.fetch
        this.now = options.now ?? Date.now
        this.callbackFactory = options.callbackFactory ?? startOpenAiOAuthCallback
    }

    async login(
        methodId: string,
        interaction: IAuthInteraction,
    ): Promise<IOAuthCredential> {
        if (methodId === OPENAI_OAUTH_BROWSER_METHOD_ID) {
            return this.loginBrowser(interaction)
        }
        if (methodId === OPENAI_OAUTH_DEVICE_METHOD_ID) {
            return this.loginDevice(interaction)
        }
        throw new Error(`Unsupported OpenAI OAuth method: ${methodId}`)
    }

    async refresh(
        credential: IOAuthCredential,
        signal: AbortSignal,
    ): Promise<IOAuthCredential> {
        throwIfAborted(signal)
        if (!isNonEmptyString(credential.refresh)) {
            throw new Error("OpenAI OAuth credential has no refresh token")
        }

        const response = await this.request(
            OPENAI_OAUTH_TOKEN_URL,
            {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({
                    grant_type: "refresh_token",
                    refresh_token: credential.refresh,
                    client_id: OPENAI_OAUTH_CLIENT_ID,
                }).toString(),
            },
            signal,
            "token refresh",
        )
        const tokens = await readTokenResponse(response, "token refresh", false)
        const existingAccountId = nonEmptyValue(credential.accountId)
        const refreshedAccountId = extractOpenAiAccountId(tokens)

        if (
            existingAccountId
            && refreshedAccountId
            && existingAccountId !== refreshedAccountId
        ) {
            throw new Error("OpenAI token refresh returned a conflicting account ID")
        }

        const accountId = refreshedAccountId ?? existingAccountId
        return {
            type: "oauth",
            access: tokens.access_token,
            refresh: tokens.refresh_token ?? credential.refresh,
            expires: this.now() + tokens.expires_in * 1000,
            ...(accountId ? { accountId } : {}),
            ...(credential.enterpriseUrl !== undefined
                ? { enterpriseUrl: credential.enterpriseUrl }
                : {}),
        }
    }

    private async loginBrowser(
        interaction: IAuthInteraction,
    ): Promise<IOAuthCredential> {
        const operation = createTimedOperation(
            interaction.signal,
            BROWSER_LOGIN_TIMEOUT_MS,
            "OpenAI browser login timed out",
        )
        let callback: IOpenAiOAuthCallback | undefined
        const manualAbort = new AbortController()
        const manualSignal = AbortSignal.any([
            operation.signal,
            manualAbort.signal,
        ])

        try {
            const authorization = await createOpenAiAuthorizationRequest()
            throwIfAborted(operation.signal)

            try {
                callback = await waitWithSignal(
                    this.callbackFactory({
                        expectedState: authorization.state,
                        signal: operation.signal,
                    }),
                    operation.signal,
                )
            } catch {
                if (operation.signal.aborted) throw abortReason(operation.signal)
                // The exact callback port may be occupied; manual input remains valid.
            }

            await waitWithSignal(
                Promise.resolve(interaction.notify({
                    type: "authorization",
                    url: authorization.url,
                    instructions:
                        "Complete ChatGPT authorization in your browser, then return here.",
                })),
                operation.signal,
            )

            const callbackPromise = callback?.waitForCode()
            const manualPromise = Promise.resolve()
                .then(() => interaction.prompt({
                    type: "manual-callback" as const,
                    message:
                        "Paste the exact callback URL, callback query, or code#state:",
                    placeholder: OPENAI_OAUTH_CALLBACK_URL,
                    signal: manualSignal,
                }))
                .then((input) => parseOpenAiManualCallback(
                    input,
                    authorization.state,
                ))
            const code = await waitWithSignal(
                callbackPromise
                    ? Promise.race([callbackPromise, manualPromise])
                    : manualPromise,
                operation.signal,
            )
            manualAbort.abort(abortError("OpenAI OAuth callback was received"))
            const tokens = await this.exchangeAuthorizationCode(
                code,
                authorization.verifier,
                OPENAI_OAUTH_CALLBACK_URL,
                operation.signal,
            )
            return initialCredential(tokens, this.now)
        } finally {
            manualAbort.abort(abortError("OpenAI OAuth login finished"))
            await callback?.close()
            operation.dispose()
        }
    }

    private async loginDevice(
        interaction: IAuthInteraction,
    ): Promise<IOAuthCredential> {
        const operation = createTimedOperation(
            interaction.signal,
            DEVICE_LOGIN_TIMEOUT_MS,
            "OpenAI device login timed out",
        )

        try {
            const startResponse = await this.request(
                OPENAI_OAUTH_DEVICE_USER_CODE_URL,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ client_id: OPENAI_OAUTH_CLIENT_ID }),
                },
                operation.signal,
                "device authorization",
            )
            if (!startResponse.ok) {
                throw new Error(
                    `OpenAI device authorization failed (${startResponse.status})`,
                )
            }
            const device = parseDeviceAuthorizationResponse(await readJson(
                startResponse,
                "OpenAI device authorization",
            ))

            await waitWithSignal(
                Promise.resolve(interaction.notify({
                    type: "device",
                    url: OPENAI_OAUTH_DEVICE_AUTHORIZATION_URL,
                    userCode: device.userCode,
                    instructions: "Open the URL and enter the device code.",
                })),
                operation.signal,
            )

            let intervalMs = device.intervalMs
            while (true) {
                throwIfAborted(operation.signal)
                const pollResponse = await this.request(
                    OPENAI_OAUTH_DEVICE_TOKEN_URL,
                    {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            device_auth_id: device.deviceAuthId,
                            user_code: device.userCode,
                        }),
                    },
                    operation.signal,
                    "device token poll",
                )

                if (pollResponse.ok) {
                    const approval = parseDeviceApprovalResponse(await readJson(
                        pollResponse,
                        "OpenAI device token poll",
                    ))
                    const tokens = await this.exchangeAuthorizationCode(
                        approval.authorizationCode,
                        approval.codeVerifier,
                        OPENAI_OAUTH_DEVICE_REDIRECT_URL,
                        operation.signal,
                    )
                    return initialCredential(tokens, this.now)
                }

                let pollStatus: "pending" | "slow_down" | undefined
                if (pollResponse.status === 403 || pollResponse.status === 404) {
                    pollStatus = "pending"
                    await pollResponse.body?.cancel()
                } else {
                    const errorCode = deviceErrorCode(await tryReadJson(pollResponse))
                    if (
                        errorCode === "authorization_pending"
                        || errorCode === "deviceauth_authorization_pending"
                    ) {
                        pollStatus = "pending"
                    } else if (errorCode === "slow_down") {
                        pollStatus = "slow_down"
                    }
                }

                if (!pollStatus) {
                    throw new Error(
                        `OpenAI device token poll failed (${pollResponse.status})`,
                    )
                }
                if (pollStatus === "slow_down") {
                    intervalMs += SLOW_DOWN_INCREMENT_MS
                }
                await abortableDelay(intervalMs, operation.signal)
            }
        } finally {
            operation.dispose()
        }
    }

    private async exchangeAuthorizationCode(
        code: string,
        verifier: string,
        redirectUrl: string,
        signal: AbortSignal,
    ): Promise<IOpenAiOAuthTokenResponse> {
        const response = await this.request(
            OPENAI_OAUTH_TOKEN_URL,
            {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({
                    grant_type: "authorization_code",
                    client_id: OPENAI_OAUTH_CLIENT_ID,
                    code,
                    code_verifier: verifier,
                    redirect_uri: redirectUrl,
                }).toString(),
            },
            signal,
            "token exchange",
        )
        return readTokenResponse(response, "token exchange", true)
    }

    private async request(
        url: string,
        init: RequestInit,
        signal: AbortSignal,
        operation: string,
    ): Promise<Response> {
        throwIfAborted(signal)
        const timeoutSignal = AbortSignal.timeout(REMOTE_REQUEST_TIMEOUT_MS)
        const requestSignal = AbortSignal.any([signal, timeoutSignal])

        try {
            return await waitWithSignal(
                this.fetcher(url, {
                    ...init,
                    redirect: "error",
                    signal: requestSignal,
                }),
                requestSignal,
            )
        } catch {
            if (signal.aborted) throw abortReason(signal)
            if (timeoutSignal.aborted) {
                throw timeoutError(`OpenAI ${operation} request timed out`)
            }
            throw new Error(`OpenAI ${operation} request failed`)
        }
    }
}

export async function createOpenAiAuthorizationRequest(): Promise<IOpenAiAuthorizationRequest> {
    const verifier = randomBase64Url(32)
    const state = randomBase64Url(32)
    const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(verifier),
    )
    const challenge = Buffer.from(digest).toString("base64url")

    return {
        verifier,
        challenge,
        state,
        url: buildOpenAiAuthorizeUrl(challenge, state),
    }
}

export function buildOpenAiAuthorizeUrl(challenge: string, state: string): string {
    const parameters = new URLSearchParams({
        response_type: "code",
        client_id: OPENAI_OAUTH_CLIENT_ID,
        redirect_uri: OPENAI_OAUTH_CALLBACK_URL,
        scope: OAUTH_SCOPE,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state,
        id_token_add_organizations: "true",
        codex_cli_simplified_flow: "true",
        originator: OPENAI_OAUTH_ORIGINATOR,
    })
    return `${OPENAI_OAUTH_AUTHORIZE_URL}?${parameters.toString()}`
}

export function parseOpenAiTokenResponse(
    value: unknown,
    options: { readonly requireRefreshToken?: boolean } = {},
): IOpenAiOAuthTokenResponse {
    if (!isRecord(value)) {
        throw new Error("OpenAI token endpoint returned an invalid response")
    }
    if (!isNonEmptyString(value.access_token)) {
        throw new Error("OpenAI token endpoint returned an invalid access token")
    }
    if (
        !Number.isFinite(value.expires_in)
        || !Number.isInteger(value.expires_in)
        || (value.expires_in as number) <= 0
    ) {
        throw new Error("OpenAI token endpoint returned an invalid expiration")
    }
    if (
        value.refresh_token !== undefined
        && !isNonEmptyString(value.refresh_token)
    ) {
        throw new Error("OpenAI token endpoint returned an invalid refresh token")
    }
    if (options.requireRefreshToken && !isNonEmptyString(value.refresh_token)) {
        throw new Error("OpenAI token endpoint did not return a refresh token")
    }
    if (value.id_token !== undefined && !isNonEmptyString(value.id_token)) {
        throw new Error("OpenAI token endpoint returned an invalid ID token")
    }

    return {
        access_token: value.access_token,
        expires_in: value.expires_in as number,
        ...(typeof value.refresh_token === "string"
            ? { refresh_token: value.refresh_token }
            : {}),
        ...(typeof value.id_token === "string"
            ? { id_token: value.id_token }
            : {}),
    }
}

/** Decodes JWT payload metadata without authenticating or trusting its signature. */
export function decodeOpenAiJwtPayload(
    token: string,
): Record<string, unknown> | undefined {
    const parts = token.split(".")
    if (parts.length !== 3 || !parts[1]) return undefined

    try {
        const value: unknown = JSON.parse(
            Buffer.from(parts[1], "base64url").toString("utf8"),
        )
        return isRecord(value) ? value : undefined
    } catch {
        return undefined
    }
}

export function extractOpenAiAccountId(
    tokens: Pick<IOpenAiOAuthTokenResponse, "access_token" | "id_token">,
): string | undefined {
    const accessTokenAccount = accountIdFromJwt(tokens.access_token)
    const idTokenAccount = tokens.id_token
        ? accountIdFromJwt(tokens.id_token)
        : undefined
    if (
        accessTokenAccount
        && idTokenAccount
        && accessTokenAccount !== idTokenAccount
    ) {
        throw new Error("OpenAI token response has conflicting account IDs")
    }
    return accessTokenAccount ?? idTokenAccount
}

export function parseOpenAiManualCallback(
    input: string,
    expectedState: string,
): string {
    const value = input.trim()
    if (!value) throw new Error("OpenAI OAuth callback input is empty")

    if (/^[a-z][a-z\d+.-]*:\/\//i.test(value)) {
        let url: URL
        try {
            url = new URL(value)
        } catch {
            throw new Error("OpenAI OAuth callback URL is invalid")
        }
        const expectedUrl = new URL(OPENAI_OAUTH_CALLBACK_URL)
        if (
            url.origin !== expectedUrl.origin
            || url.pathname !== expectedUrl.pathname
            || url.username
            || url.password
            || url.hash
        ) {
            throw new Error("OpenAI OAuth callback URL does not match the expected URL")
        }
        return codeFromParameters(url.searchParams, expectedState)
    }

    if (
        value.startsWith("?")
        || value.includes("&")
        || /^(?:code|state|error|error_description)=/.test(value)
    ) {
        return codeFromParameters(
            new URLSearchParams(value.replace(/^\?/, "")),
            expectedState,
        )
    }

    const separator = value.indexOf("#")
    if (separator <= 0 || separator !== value.lastIndexOf("#")) {
        throw new Error("OpenAI OAuth callback must include its state")
    }
    const code = value.slice(0, separator)
    const state = value.slice(separator + 1)
    if (!code) throw new Error("OpenAI OAuth callback has no authorization code")
    if (!state || state !== expectedState) {
        throw new Error("OpenAI OAuth callback state did not match")
    }
    return code
}

function initialCredential(
    tokens: IOpenAiOAuthTokenResponse,
    now: () => number,
): IOAuthCredential {
    if (!tokens.refresh_token) {
        throw new Error("OpenAI token endpoint did not return a refresh token")
    }
    const accountId = extractOpenAiAccountId(tokens)
    if (!accountId) {
        throw new Error("OpenAI token response has no ChatGPT account ID")
    }
    return {
        type: "oauth",
        access: tokens.access_token,
        refresh: tokens.refresh_token,
        expires: now() + tokens.expires_in * 1000,
        accountId,
    }
}

async function readTokenResponse(
    response: Response,
    operation: string,
    requireRefreshToken: boolean,
): Promise<IOpenAiOAuthTokenResponse> {
    if (!response.ok) {
        const guidance = operation === "token refresh"
            && (response.status === 400 || response.status === 401)
            ? ". Run `buli login` again."
            : ""
        throw new Error(
            `OpenAI ${operation} failed (${response.status})${guidance}`,
        )
    }
    return parseOpenAiTokenResponse(
        await readJson(response, `OpenAI ${operation}`),
        { requireRefreshToken },
    )
}

function accountIdFromJwt(token: string): string | undefined {
    const payload = decodeOpenAiJwtPayload(token)
    if (!payload) return undefined

    const topLevel = nonEmptyValue(payload.chatgpt_account_id)
    if (topLevel) return topLevel
    const nested = payload[JWT_AUTH_CLAIM]
    return isRecord(nested)
        ? nonEmptyValue(nested.chatgpt_account_id)
        : undefined
}

function codeFromParameters(
    parameters: URLSearchParams,
    expectedState: string,
): string {
    const states = parameters.getAll("state")
    if (states.length !== 1 || !states[0] || states[0] !== expectedState) {
        throw new Error("OpenAI OAuth callback state did not match")
    }
    if (parameters.get("error")) {
        throw new Error("OpenAI authorization was not approved")
    }
    const codes = parameters.getAll("code")
    if (codes.length !== 1 || !codes[0]) {
        throw new Error("OpenAI OAuth callback has no authorization code")
    }
    return codes[0]
}

interface IDeviceAuthorization {
    readonly deviceAuthId: string
    readonly userCode: string
    readonly intervalMs: number
}

function parseDeviceAuthorizationResponse(value: unknown): IDeviceAuthorization {
    if (
        !isRecord(value)
        || !isNonEmptyString(value.device_auth_id)
        || !isNonEmptyString(value.user_code)
    ) {
        throw new Error("OpenAI device authorization returned an invalid response")
    }

    let intervalMs = DEFAULT_DEVICE_INTERVAL_MS
    if (value.interval !== undefined) {
        const interval = typeof value.interval === "string"
            && value.interval.trim()
            ? Number(value.interval)
            : value.interval
        if (
            typeof interval !== "number"
            || !Number.isFinite(interval)
            || interval < 0
        ) {
            throw new Error("OpenAI device authorization returned an invalid interval")
        }
        intervalMs = Math.floor(interval * 1000)
    }

    return {
        deviceAuthId: value.device_auth_id,
        userCode: value.user_code,
        intervalMs: Math.max(MINIMUM_DEVICE_INTERVAL_MS, intervalMs),
    }
}

interface IDeviceApproval {
    readonly authorizationCode: string
    readonly codeVerifier: string
}

function parseDeviceApprovalResponse(value: unknown): IDeviceApproval {
    if (
        !isRecord(value)
        || !isNonEmptyString(value.authorization_code)
        || !isNonEmptyString(value.code_verifier)
    ) {
        throw new Error("OpenAI device token endpoint returned an invalid response")
    }
    return {
        authorizationCode: value.authorization_code,
        codeVerifier: value.code_verifier,
    }
}

function deviceErrorCode(value: unknown): string | undefined {
    if (!isRecord(value)) return undefined
    if (isNonEmptyString(value.error)) return value.error
    if (isRecord(value.error) && isNonEmptyString(value.error.code)) {
        return value.error.code
    }
    return isNonEmptyString(value.code) ? value.code : undefined
}

async function readJson(response: Response, operation: string): Promise<unknown> {
    try {
        return await response.json()
    } catch {
        throw new Error(`${operation} returned invalid JSON`)
    }
}

async function tryReadJson(response: Response): Promise<unknown> {
    try {
        return await response.json()
    } catch {
        return undefined
    }
}

function randomBase64Url(byteLength: number): string {
    return Buffer.from(crypto.getRandomValues(new Uint8Array(byteLength))).toString(
        "base64url",
    )
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0
}

function nonEmptyValue(value: unknown): string | undefined {
    return isNonEmptyString(value) ? value : undefined
}

interface ITimedOperation {
    readonly signal: AbortSignal
    readonly dispose: () => void
}

function createTimedOperation(
    callerSignal: AbortSignal,
    timeoutMs: number,
    timeoutMessage: string,
): ITimedOperation {
    const controller = new AbortController()
    const onAbort = (): void => {
        if (!controller.signal.aborted) {
            controller.abort(abortReason(callerSignal))
        }
    }
    callerSignal.addEventListener("abort", onAbort, { once: true })
    if (callerSignal.aborted) onAbort()

    const timeout = setTimeout(() => {
        if (!controller.signal.aborted) {
            controller.abort(timeoutError(timeoutMessage))
        }
    }, timeoutMs)

    return {
        signal: controller.signal,
        dispose: () => {
            clearTimeout(timeout)
            callerSignal.removeEventListener("abort", onAbort)
        },
    }
}

function waitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(abortReason(signal))

    return new Promise<T>((resolve, reject) => {
        let settled = false
        const finish = (run: () => void): void => {
            if (settled) return
            settled = true
            signal.removeEventListener("abort", onAbort)
            run()
        }
        const onAbort = (): void => finish(() => reject(abortReason(signal)))
        signal.addEventListener("abort", onAbort, { once: true })
        if (signal.aborted) onAbort()

        promise.then(
            (value) => finish(() => resolve(value)),
            (error: unknown) => finish(() => reject(error)),
        )
    })
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(abortReason(signal))

    return new Promise((resolve, reject) => {
        const onAbort = (): void => {
            clearTimeout(timeout)
            reject(abortReason(signal))
        }
        const timeout = setTimeout(() => {
            signal.removeEventListener("abort", onAbort)
            resolve()
        }, milliseconds)
        signal.addEventListener("abort", onAbort, { once: true })
    })
}

function throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) throw abortReason(signal)
}

function abortReason(signal: AbortSignal): Error {
    return signal.reason instanceof Error
        ? signal.reason
        : abortError("OpenAI OAuth operation was cancelled")
}

function abortError(message: string): Error {
    const error = new Error(message)
    error.name = "AbortError"
    return error
}

function timeoutError(message: string): Error {
    const error = new Error(message)
    error.name = "TimeoutError"
    return error
}
