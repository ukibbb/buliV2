import type {
    IAuthInteraction,
    IAuthMethodInfo,
    IAuthStatus,
} from "@/auth/contracts"

export interface IOAuthCredential {
    readonly type: "oauth"
    readonly refresh: string
    readonly access: string
    readonly expires: number
    readonly accountId?: string
    readonly enterpriseUrl?: string
}

export interface IApiKeyCredential {
    readonly type: "api_key"
    readonly key: string
}

export type TAuthCredential = IOAuthCredential | IApiKeyCredential

export interface IAuthStore {
    readonly get: (
        providerId: string,
        signal?: AbortSignal,
    ) => Promise<TAuthCredential | undefined>
    readonly set: (
        providerId: string,
        credential: TAuthCredential,
        signal?: AbortSignal,
    ) => Promise<void>
    readonly remove: (
        providerId: string,
        signal?: AbortSignal,
    ) => Promise<boolean>
    readonly modify: (
        providerId: string,
        update: (
            current: TAuthCredential | undefined,
        ) => Promise<TAuthCredential | undefined>,
        signal?: AbortSignal,
    ) => Promise<TAuthCredential | undefined>
    readonly beginOperation: (
        providerId: string,
        signal?: AbortSignal,
    ) => Promise<number>
    readonly commitOperation: (
        providerId: string,
        operation: number,
        credential: TAuthCredential,
        signal?: AbortSignal,
    ) => Promise<boolean>
}

export interface IAuthenticationProvider {
    readonly id: string
    readonly name: string
    readonly methods: readonly IAuthMethodInfo[]
    readonly status: (signal?: AbortSignal) => Promise<IAuthStatus>
    readonly login: (
        methodId: string,
        interaction: IAuthInteraction,
    ) => Promise<IAuthStatus>
    readonly logout: (signal: AbortSignal) => Promise<boolean>
    readonly dispose?: (reason?: unknown) => void | Promise<void>
}
