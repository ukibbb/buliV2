import type {
    IAuthInteraction,
    IAuthProviderInfo,
    IAuthStatus,
    IAuthenticationService,
} from "@/authentication/contracts"
import type { IAuthenticationProvider } from "@/authentication/credentials"

/** Coordinates provider-independent login/logout operations and their lifetime. */
export class AuthenticationService implements IAuthenticationService {
    private readonly providers: ReadonlyMap<string, IAuthenticationProvider>
    // Serwis jest właścicielem wszystkich operacji wywołanych przez jego fasadę.
    // Dzięki temu dispose zamyka bramkę dla nowej pracy i może zaczekać na starą.
    private readonly lifetime = new AbortController()
    private readonly activeOperations = new Set<Promise<unknown>>()
    // Wielu właścicieli może poprosić o shutdown, ale providery sprzątamy tylko raz.
    private disposePromise: Promise<void> | undefined

    constructor(providers: readonly IAuthenticationProvider[]) {
        const entries = providers.map((provider) => [provider.id, provider] as const)
        this.providers = new Map(entries)
        if (this.providers.size !== entries.length) {
            throw new Error("Authentication provider IDs must be unique")
        }
    }

    readonly listProviders = async (
        signal?: AbortSignal,
    ): Promise<readonly IAuthProviderInfo[]> => this.runOperation(
        signal,
        async (operationSignal) => Promise.all(
            [...this.providers.values()].map(async (provider) => {
                let status: IAuthStatus
                let statusFailed = false
                try {
                    status = await provider.status(operationSignal)
                } catch {
                    operationSignal.throwIfAborted()
                    status = { providerId: provider.id, connected: false }
                    statusFailed = true
                }
                return {
                    ...status,
                    name: provider.name,
                    methods: provider.methods.map((method) => ({ ...method })),
                    ...(statusFailed
                        ? { statusError: "Authentication status is unavailable" }
                        : {}),
                }
            }),
        ),
    )

    readonly login = async (
        providerId: string,
        methodId: string,
        interaction: IAuthInteraction,
    ): Promise<IAuthStatus> => this.runOperation(
        interaction.signal,
        async (operationSignal) => {
            const provider = this.requireProvider(providerId)
            if (!provider.methods.some((method) => method.id === methodId)) {
                throw new Error(`Unsupported ${provider.name} login method: ${methodId}`)
            }
            return provider.login(methodId, {
                ...interaction,
                signal: operationSignal,
            })
        },
    )

    readonly logout = (
        providerId: string,
        signal: AbortSignal,
    ): Promise<boolean> => this.runOperation(
        signal,
        async (operationSignal) => this.requireProvider(providerId).logout(
            operationSignal,
        ),
    )

    // Wspólny Promise zachowuje idempotencję i pozwala wszystkim czekać na ten sam wynik.
    readonly dispose = (reason?: unknown): Promise<void> => {
        if (this.disposePromise) return this.disposePromise

        // Najpierw publikujemy Promise, dopiero potem wywołujemy providery. Provider
        // może synchronicznie wejść ponownie w dispose() i musi dostać ten sam Promise.
        const disposeCompletion = Promise.withResolvers<void>()
        this.disposePromise = disposeCompletion.promise
        void this.disposeInternal(reason).then(
            disposeCompletion.resolve,
            disposeCompletion.reject,
        )
        return this.disposePromise
    }

    private async disposeInternal(reason?: unknown): Promise<void> {
        const shutdownReason = reason ?? abortError(
            "Authentication service is shutting down",
        )
        // Abort jest synchroniczną bramką. Snapshot wykonujemy po nim, aby objąć
        // także operacje dodane reentrantnie przez listenery abort.
        if (!this.lifetime.signal.aborted) this.lifetime.abort(shutdownReason)
        const activeOperations = [...this.activeOperations]
        const providerDisposals = [...this.providers.values()].map(
            async (provider) => provider.dispose?.(shutdownReason),
        )
        const [providerResults] = await Promise.all([
            Promise.allSettled(providerDisposals),
            // Błędy operacji należą do ich callerów; dispose ma tylko zaczekać,
            // aż operacje zareagują na anulowanie i zwolnią swoje zasoby.
            Promise.allSettled(activeOperations),
        ])
        const errors = providerResults.flatMap((result) =>
            result.status === "rejected" ? [result.reason] : []
        )
        if (errors.length > 0) {
            throw new AggregateError(errors, "Authentication shutdown failed")
        }
    }

    private runOperation<TResult>(
        callerSignal: AbortSignal | undefined,
        run: (signal: AbortSignal) => Promise<TResult>,
    ): Promise<TResult> {
        // Rejestrujemy Promise przed pierwszym await. Równoczesny dispose zawsze
        // zobaczy operację, nawet gdy nie zdążyła jeszcze wejść do providera.
        const operation = Promise.resolve().then(async () => {
            this.lifetime.signal.throwIfAborted()
            callerSignal?.throwIfAborted()
            const signal = callerSignal
                ? AbortSignal.any([callerSignal, this.lifetime.signal])
                : this.lifetime.signal
            return run(signal)
        })
        this.activeOperations.add(operation)
        void operation.then(
            () => this.activeOperations.delete(operation),
            () => this.activeOperations.delete(operation),
        )
        return operation
    }

    private requireProvider(providerId: string): IAuthenticationProvider {
        const provider = this.providers.get(providerId)
        if (!provider) throw new Error(`Unknown authentication provider: ${providerId}`)
        return provider
    }
}

function abortError(message: string): Error {
    const error = new Error(message)
    error.name = "AbortError"
    return error
}
