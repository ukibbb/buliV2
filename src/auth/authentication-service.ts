import type {
    IAuthInteraction,
    IAuthProviderInfo,
    IAuthStatus,
    IAuthenticationService,
} from "@/auth/contracts"
import type { IAuthenticationProvider } from "@/auth/types"

export class AuthenticationService implements IAuthenticationService {
    private readonly providers: ReadonlyMap<string, IAuthenticationProvider>
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
    ): Promise<readonly IAuthProviderInfo[]> => {
        signal?.throwIfAborted()
        return Promise.all([...this.providers.values()].map(async (provider) => {
            let status: IAuthStatus
            let statusFailed = false
            try {
                status = await provider.status(signal)
            } catch {
                signal?.throwIfAborted()
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
        }))
    }

    readonly login = async (
        providerId: string,
        methodId: string,
        interaction: IAuthInteraction,
    ): Promise<IAuthStatus> => {
        const provider = this.requireProvider(providerId)
        if (!provider.methods.some((method) => method.id === methodId)) {
            throw new Error(`Unsupported ${provider.name} login method: ${methodId}`)
        }
        return provider.login(methodId, interaction)
    }

    readonly logout = (
        providerId: string,
        signal: AbortSignal,
    ): Promise<boolean> => this.requireProvider(providerId).logout(signal)

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
        const results = await Promise.allSettled(
            [...this.providers.values()].map(async (provider) => {
                await provider.dispose?.(reason)
            }),
        )
        const errors = results.flatMap((result) =>
            result.status === "rejected" ? [result.reason] : []
        )
        if (errors.length > 0) {
            throw new AggregateError(errors, "Authentication shutdown failed")
        }
    }

    private requireProvider(providerId: string): IAuthenticationProvider {
        const provider = this.providers.get(providerId)
        if (!provider) throw new Error(`Unknown authentication provider: ${providerId}`)
        return provider
    }
}
