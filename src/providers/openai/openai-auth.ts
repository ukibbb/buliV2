import type {
    IAuthInteraction,
    IAuthMethodInfo,
    IAuthStatus,
} from "@/auth/contracts"
import { FileAuthStore } from "@/auth/file-auth-store"
import type {
    IAuthenticationProvider,
    IAuthStore,
    IOAuthCredential,
    TAuthCredential,
} from "@/auth/types"
import {
    createOpenAiCodexFetch,
    type IOpenAiCodexCredentialProvider,
} from "@/providers/openai/openai-codex-fetch"
import {
    OPENAI_OAUTH_BROWSER_METHOD_ID,
    OPENAI_OAUTH_DEVICE_METHOD_ID,
    OpenAiOAuth,
    extractOpenAiAccountId,
} from "@/providers/openai/openai-oauth"

export const OPENAI_PROVIDER_ID = "openai"

const OPENAI_REFRESH_SKEW_MS = 5 * 60 * 1000

const OPENAI_AUTH_METHODS: readonly IAuthMethodInfo[] = [
    {
        id: OPENAI_OAUTH_BROWSER_METHOD_ID,
        name: "Browser login",
        description: "Sign in to ChatGPT using a browser callback",
    },
    {
        id: OPENAI_OAUTH_DEVICE_METHOD_ID,
        name: "Device code",
        description: "Sign in using a code on another device",
    },
]

export interface IOpenAiAuth
    extends IAuthenticationProvider, IOpenAiCodexCredentialProvider {
    readonly authenticatedFetch: typeof fetch
    readonly getCredential: (
        signal?: AbortSignal,
    ) => Promise<IOAuthCredential | undefined>
    readonly dispose: (reason?: unknown) => Promise<void>
}

export interface IOpenAiAuthOptions {
    readonly store?: IAuthStore
    readonly oauth?: OpenAiOAuth
    readonly fetch?: typeof fetch
    readonly now?: () => number
    readonly signal?: AbortSignal
}

/** Owns the complete ChatGPT OAuth credential lifecycle for OpenAI Codex. */
export class OpenAiAuth implements IOpenAiAuth {
    readonly id = OPENAI_PROVIDER_ID
    readonly name = "OpenAI / ChatGPT"
    readonly methods = OPENAI_AUTH_METHODS
    readonly authenticatedFetch: typeof fetch

    private readonly store: IAuthStore
    private readonly oauth: OpenAiOAuth
    private readonly now: () => number
    private readonly lifetime = new AbortController()
    private readonly requestFlights = new Set<Promise<Response>>()
    private refreshFlight: Promise<IOAuthCredential> | undefined
    private activeLogin: AbortController | undefined
    private readonly activeLoginTasks = new Set<Promise<void>>()
    private loginGeneration = 0
    // Root AbortSignal i cleanup aplikacji mogą wywołać dispose równocześnie.
    // Jeden Promise gwarantuje jeden abort, jeden snapshot tasków i pierwszy reason.
    private disposePromise: Promise<void> | undefined

    constructor(options: IOpenAiAuthOptions = {}) {
        this.store = options.store ?? new FileAuthStore()
        this.now = options.now ?? Date.now
        const rawFetch = options.fetch ?? globalThis.fetch
        this.oauth = options.oauth ?? new OpenAiOAuth({
            fetch: rawFetch,
            now: this.now,
        })
        const codexFetch = createOpenAiCodexFetch({
            credentials: this,
            fetch: rawFetch,
            signal: this.lifetime.signal,
        })
        const authenticatedFetch = async (
            ...args: Parameters<typeof globalThis.fetch>
        ): Promise<Response> => {
            const flight = codexFetch(...args)
            this.requestFlights.add(flight)
            try {
                return await flight
            } finally {
                this.requestFlights.delete(flight)
            }
        }
        this.authenticatedFetch = Object.assign(authenticatedFetch, {
            preconnect: codexFetch.preconnect,
        })

        if (options.signal) {
            const dispose = (): void => {
                void this.dispose(options.signal?.reason).catch(() => {})
            }
            options.signal.addEventListener("abort", dispose, { once: true })
            if (options.signal.aborted) dispose()
        }
    }

    readonly status = async (signal?: AbortSignal): Promise<IAuthStatus> => {
        const credential = await this.getCredential(signal)
        if (!credential) {
            return { providerId: this.id, connected: false }
        }
        return {
            providerId: this.id,
            connected: true,
            expiresAt: credential.expires,
            ...(credential.accountId ? { accountId: credential.accountId } : {}),
        }
    }

    readonly login = async (
        methodId: string,
        interaction: IAuthInteraction,
    ): Promise<IAuthStatus> => {
        this.lifetime.signal.throwIfAborted()
        this.activeLogin?.abort(abortError("A newer OpenAI login was started"))
        const generation = ++this.loginGeneration
        const controller = new AbortController()
        this.activeLogin = controller
        const signal = AbortSignal.any([
            interaction.signal,
            controller.signal,
            this.lifetime.signal,
        ])
        const loginDone = Promise.withResolvers<void>()
        this.activeLoginTasks.add(loginDone.promise)

        try {
            const operation = await this.store.beginOperation(this.id, signal)
            const credential = await this.oauth.login(methodId, {
                ...interaction,
                signal,
            })
            if (generation !== this.loginGeneration) {
                throw abortError("OpenAI login was replaced")
            }

            const committed = generation === this.loginGeneration
                && await this.store.commitOperation(this.id, operation, credential)
            if (
                generation !== this.loginGeneration
                || !committed
            ) {
                throw abortError("OpenAI login was replaced")
            }
            return statusFromCredential(this.id, credential)
        } finally {
            loginDone.resolve()
            this.activeLoginTasks.delete(loginDone.promise)
            if (this.activeLogin === controller) this.activeLogin = undefined
        }
    }

    readonly logout = async (signal: AbortSignal): Promise<boolean> => {
        signal.throwIfAborted()
        this.loginGeneration += 1
        this.activeLogin?.abort(abortError("OpenAI login was cancelled by logout"))
        this.activeLogin = undefined
        return this.store.remove(this.id, signal)
    }

    readonly getCredential = async (
        signal?: AbortSignal,
    ): Promise<IOAuthCredential | undefined> => {
        const credential = await this.store.get(this.id, signal)
        return credential
            ? requireOpenAiOAuthCredential(credential)
            : undefined
    }

    readonly requireCredential = async (
        signal?: AbortSignal,
    ): Promise<IOAuthCredential> => {
        this.lifetime.signal.throwIfAborted()
        signal?.throwIfAborted()
        const credential = await this.getCredential(signal)
        if (!credential) throw missingAuthError()

        const normalized = normalizeStoredAccount(credential)
        if (
            normalized.accountId
            && normalized.expires > this.now() + OPENAI_REFRESH_SKEW_MS
        ) {
            if (normalized !== credential) {
                await this.persistNormalizedCredential(credential.access, normalized)
            }
            return normalized
        }
        return this.refreshCredential(undefined, signal)
    }

    readonly refreshAfterUnauthorized = async (
        observedAccessToken: string,
        observedAccountId: string,
        signal?: AbortSignal,
    ): Promise<IOAuthCredential> => {
        let credential = await this.refreshCredential(observedAccessToken, signal)
        if (credential.access === observedAccessToken) {
            credential = await this.refreshCredential(observedAccessToken, signal)
        }
        if (credential.accountId !== observedAccountId) {
            throw new Error(
                "OpenAI account changed while retrying an unauthorized request",
            )
        }
        return credential
    }

    // Metoda nie jest async, aby każdy caller dostał dokładnie ten sam Promise.
    readonly dispose = (
        reason: unknown = abortError("OpenAI authentication is shutting down"),
    ): Promise<void> => {
        if (this.disposePromise) return this.disposePromise

        // Pole ustawiamy przed disposeInternal(), bo abort synchronicznie wywołuje
        // obcy kod, który może reentrantnie poprosić o ten sam disposal.
        const disposeCompletion = Promise.withResolvers<void>()
        this.disposePromise = disposeCompletion.promise
        void this.disposeInternal(reason).then(
            disposeCompletion.resolve,
            disposeCompletion.reject,
        )
        return this.disposePromise
    }

    private async disposeInternal(reason: unknown): Promise<void> {
        this.loginGeneration += 1
        // Najpierw zamykamy bramkę dla nowej pracy. Listenery abort mogą wywołać
        // publiczne metody synchronicznie, ale zobaczą już anulowany lifetime.
        if (!this.lifetime.signal.aborted) this.lifetime.abort(reason)
        this.activeLogin?.abort(reason)
        this.activeLogin = undefined

        // Snapshot powstaje po abort, więc obejmuje także pracę rozpoczętą
        // reentrantnie przez listener tuż przed zamknięciem bramki.
        const loginTasks = [...this.activeLoginTasks]
        const refreshFlight = this.refreshFlight
        const requestFlights = [...this.requestFlights]
        await Promise.allSettled([
            ...loginTasks,
            ...(refreshFlight ? [refreshFlight] : []),
            ...requestFlights,
        ])
    }

    private refreshCredential(
        observedAccessToken: string | undefined,
        signal?: AbortSignal,
    ): Promise<IOAuthCredential> {
        signal?.throwIfAborted()
        this.lifetime.signal.throwIfAborted()
        this.refreshFlight ??= this.refreshUnderLock(observedAccessToken)
            .finally(() => {
                this.refreshFlight = undefined
            })
        return waitWithSignal(this.refreshFlight, signal)
    }

    private async refreshUnderLock(
        observedAccessToken: string | undefined,
    ): Promise<IOAuthCredential> {
        const credential = await this.store.modify(
            this.id,
            async (current) => {
                if (!current) throw missingAuthError()
                const normalized = normalizeStoredAccount(
                    requireOpenAiOAuthCredential(current),
                )
                const tokenChanged = observedAccessToken !== undefined
                    && normalized.access !== observedAccessToken
                if (
                    normalized.accountId
                    && (
                        tokenChanged
                        || (
                            observedAccessToken === undefined
                            && normalized.expires
                                > this.now() + OPENAI_REFRESH_SKEW_MS
                        )
                    )
                ) {
                    return normalized
                }

                const refreshed = await this.oauth.refresh(
                    normalized,
                    this.lifetime.signal,
                )
                if (!refreshed.accountId) {
                    throw new Error(
                        "OpenAI token has no ChatGPT account ID; run `buli login` again",
                    )
                }
                return refreshed
            },
            this.lifetime.signal,
        )
        if (!credential) throw missingAuthError()
        return requireOpenAiOAuthCredential(credential)
    }

    private async persistNormalizedCredential(
        observedAccessToken: string,
        normalized: IOAuthCredential,
    ): Promise<void> {
        await this.store.modify(this.id, async (current) => {
            if (
                !current
                || current.type !== "oauth"
                || current.access !== observedAccessToken
            ) return current
            return normalized
        }, this.lifetime.signal)
    }
}

function requireOpenAiOAuthCredential(
    credential: TAuthCredential,
): IOAuthCredential {
    if (credential.type !== "oauth") {
        throw new Error("OpenAI / ChatGPT requires an OAuth credential")
    }
    return credential
}

function normalizeStoredAccount(
    credential: IOAuthCredential,
): IOAuthCredential {
    const extracted = extractOpenAiAccountId({
        access_token: credential.access,
    })
    if (
        credential.accountId
        && extracted
        && credential.accountId !== extracted
    ) {
        throw new Error("Stored OpenAI credential has a conflicting account ID")
    }
    if (credential.accountId || !extracted) return credential
    return { ...credential, accountId: extracted }
}

function statusFromCredential(
    providerId: string,
    credential: IOAuthCredential,
): IAuthStatus {
    return {
        providerId,
        connected: true,
        expiresAt: credential.expires,
        ...(credential.accountId ? { accountId: credential.accountId } : {}),
    }
}

function missingAuthError(): Error {
    return new Error("OpenAI is not connected. Run `buli login`.")
}

function waitWithSignal<T>(
    promise: Promise<T>,
    signal?: AbortSignal,
): Promise<T> {
    if (!signal) return promise
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
        promise.then(
            (value) => finish(() => resolve(value)),
            (error: unknown) => finish(() => reject(error)),
        )
    })
}

function abortReason(signal: AbortSignal): Error {
    return signal.reason instanceof Error
        ? signal.reason
        : abortError("OpenAI authentication was cancelled")
}

function abortError(message: string): Error {
    const error = new Error(message)
    error.name = "AbortError"
    return error
}
