export interface IAuthMethodInfo {
    readonly id: string
    readonly name: string
    readonly description: string
}

export interface IAuthStatus {
    readonly providerId: string
    readonly connected: boolean
    readonly accountId?: string
    readonly expiresAt?: number
}

export interface IAuthProviderInfo extends IAuthStatus {
    readonly name: string
    readonly methods: readonly IAuthMethodInfo[]
    readonly statusError?: string
}

export type TAuthEvent =
    | {
        readonly type: "progress"
        readonly message: string
    }
    | {
        readonly type: "authorization"
        readonly url: string
        readonly instructions: string
    }
    | {
        readonly type: "device"
        readonly url: string
        readonly userCode: string
        readonly instructions: string
    }

export interface IAuthPrompt {
    readonly type: "manual-callback"
    readonly message: string
    readonly placeholder: string
    readonly signal: AbortSignal
}

export interface IAuthInteraction {
    readonly signal: AbortSignal
    readonly notify: (event: TAuthEvent) => void | Promise<void>
    readonly prompt: (prompt: IAuthPrompt) => Promise<string>
}

export interface IAuthenticationService {
    readonly listProviders: (
        signal?: AbortSignal,
    ) => Promise<readonly IAuthProviderInfo[]>
    readonly login: (
        providerId: string,
        methodId: string,
        interaction: IAuthInteraction,
    ) => Promise<IAuthStatus>
    readonly logout: (
        providerId: string,
        signal: AbortSignal,
    ) => Promise<boolean>
    // Serwis jest ownerem providerów, więc każdy composition root ma jeden
    // wymagany i oczekiwalny punkt zakończenia całej warstwy authentication.
    readonly dispose: (reason?: unknown) => Promise<void>
}
