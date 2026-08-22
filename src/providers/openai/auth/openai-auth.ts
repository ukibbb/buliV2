import {
    FileAuthStore,
    type IAuthInteraction,
    type IAuthenticationProvider,
    type IAuthMethodInfo,
    type IAuthStatus,
    type IAuthStore,
    type IOAuthCredential,
    type TAuthCredential,
} from "@/authentication"
import {
    createOpenAiCodexFetch,
    type IOpenAiCodexCredentialProvider,
} from "@/providers/openai/transport/codex-fetch"
import {
    OPENAI_OAUTH_BROWSER_METHOD_ID,
    OPENAI_OAUTH_DEVICE_METHOD_ID,
    OpenAiOAuth,
    extractOpenAiAccountId,
} from "@/providers/openai/auth/oauth"

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
    // Operacje store wywoływane bezpośrednio przez model także należą do providera,
    // nie tylko wywołania przechodzące przez AuthenticationService.
    private readonly activeOperations = new Set<Promise<unknown>>()
    private refreshFlight: Promise<IOAuthCredential> | undefined
    private activeLogin: AbortController | undefined
    private readonly activeLoginTasks = new Set<Promise<void>>()
    private loginGeneration = 0
    // Root AbortSignal i cleanup aplikacji mogą wywołać dispose równocześnie.
    // Jeden Promise gwarantuje jeden abort, jeden snapshot tasków i pierwszy reason.
    private disposePromise: Promise<void> | undefined
    private removeRootAbortListener: (() => void) | undefined

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
            const rootSignal = options.signal
            const dispose = (): void => {
                void this.dispose(rootSignal.reason).catch(() => {})
            }
            rootSignal.addEventListener("abort", dispose, { once: true })
            this.removeRootAbortListener = () => {
                rootSignal.removeEventListener("abort", dispose)
            }
            if (rootSignal.aborted) dispose()
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

            let committed = false
            try {
                committed = generation === this.loginGeneration
                    && await this.store.commitOperation(
                        this.id,
                        operation,
                        credential,
                        signal,
                    )
            } catch (error) {
                // Logout i nowszy login zmieniają generation. Zachowujemy dla nich
                // stabilny komunikat niezależnie od miejsca, w którym commit przerwał.
                if (generation !== this.loginGeneration) {
                    throw abortError("OpenAI login was replaced")
                }
                throw error
            }
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

    readonly logout = async (signal: AbortSignal): Promise<boolean> => this.trackOperation(
        async () => {
            const operationSignal = this.operationSignal(signal)
            this.loginGeneration += 1
            this.activeLogin?.abort(abortError("OpenAI login was cancelled by logout"))
            this.activeLogin = undefined
            return this.store.remove(this.id, operationSignal)
        },
    )

    readonly getCredential = async (
        signal?: AbortSignal,
    ): Promise<IOAuthCredential | undefined> => this.trackOperation(async () => {
        const operationSignal = this.operationSignal(signal)
        return this.readCredential(operationSignal)
    })

    readonly requireCredential = async (
        signal?: AbortSignal,
    ): Promise<IOAuthCredential> => this.trackOperation(async () => {
        const operationSignal = this.operationSignal(signal)
        while (true) {
            const credential = await this.readCredential(operationSignal)
            if (!credential) throw missingAuthError()

            const normalized = normalizeStoredAccount(credential)
            if (
                normalized.accountId
                && normalized.expires > this.now() + OPENAI_REFRESH_SKEW_MS
            ) {
                if (normalized === credential) return normalized
                const persisted = await this.persistNormalizedCredential(
                    credential,
                    normalized,
                    operationSignal,
                )
                if (oauthCredentialsEqual(persisted, normalized)) return persisted
                // Credential zmienił się przed CAS. Oceniamy najnowszą wartość
                // od początku, zamiast zwracać potencjalnie nieaktualny snapshot.
                continue
            }
            return this.refreshCredential(undefined, operationSignal)
        }
    })

    readonly refreshAfterUnauthorized = async (
        observedAccessToken: string,
        observedAccountId: string,
        signal?: AbortSignal,
    ): Promise<IOAuthCredential> => this.trackOperation(async () => {
        const operationSignal = this.operationSignal(signal)
        let credential = await this.refreshCredential(
            observedAccessToken,
            operationSignal,
        )
        if (credential.access === observedAccessToken) {
            credential = await this.refreshCredential(
                observedAccessToken,
                operationSignal,
            )
        }
        if (credential.accountId !== observedAccountId) {
            throw new Error(
                "OpenAI account changed while retrying an unauthorized request",
            )
        }
        return credential
    })

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
        this.removeRootAbortListener?.()
        this.removeRootAbortListener = undefined
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
        const activeOperations = [...this.activeOperations]
        await Promise.allSettled([
            ...loginTasks,
            ...(refreshFlight ? [refreshFlight] : []),
            ...requestFlights,
            ...activeOperations,
        ])
    }

    private refreshCredential(
        observedAccessToken: string | undefined,
        signal?: AbortSignal,
    ): Promise<IOAuthCredential> {
        signal?.throwIfAborted()
        this.lifetime.signal.throwIfAborted()
        this.refreshFlight ??= this.refreshStoredCredential(observedAccessToken)
            .finally(() => {
                this.refreshFlight = undefined
            })
        return waitWithSignal(this.refreshFlight, signal)
    }

    private async refreshStoredCredential(
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

                // Refresh token może być rotowany i unieważniany przez serwer.
                // Wspólny refreshFlight chroni tę instancję providera przed
                // równoczesnym zużyciem tego samego jednorazowego tokena.
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
        observed: IOAuthCredential,
        normalized: IOAuthCredential,
        signal: AbortSignal,
    ): Promise<IOAuthCredential> {
        const persisted = await this.store.modify(this.id, async (current) => {
            if (!current) return undefined
            const currentOAuth = requireOpenAiOAuthCredential(current)
            if (!oauthCredentialsEqual(currentOAuth, observed)) return currentOAuth
            return normalized
        }, signal)
        if (!persisted) throw missingAuthError()
        return requireOpenAiOAuthCredential(persisted)
    }

    private async readCredential(
        signal: AbortSignal,
    ): Promise<IOAuthCredential | undefined> {
        const credential = await this.store.get(this.id, signal)
        return credential
            ? requireOpenAiOAuthCredential(credential)
            : undefined
    }

    private operationSignal(signal?: AbortSignal): AbortSignal {
        this.lifetime.signal.throwIfAborted()
        signal?.throwIfAborted()
        return signal
            ? AbortSignal.any([signal, this.lifetime.signal])
            : this.lifetime.signal
    }

    private trackOperation<TResult>(
        run: () => Promise<TResult>,
    ): Promise<TResult> {
        this.lifetime.signal.throwIfAborted()
        // Promise jest publikowany przed wejściem do obcego store. Gdy store
        // reentrantnie uruchomi dispose, shutdown zobaczy już tę operację.
        const completion = Promise.withResolvers<TResult>()
        const operation = completion.promise
        this.activeOperations.add(operation)
        try {
            void run().then(completion.resolve, completion.reject)
        } catch (error) {
            completion.reject(error)
        }
        void operation.then(
            () => this.activeOperations.delete(operation),
            () => this.activeOperations.delete(operation),
        )
        return operation
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

function oauthCredentialsEqual(
    left: IOAuthCredential,
    right: IOAuthCredential,
): boolean {
    return left.access === right.access
        && left.refresh === right.refresh
        && left.expires === right.expires
        && left.accountId === right.accountId
        && left.enterpriseUrl === right.enterpriseUrl
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
