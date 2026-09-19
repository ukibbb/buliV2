import type { IAuthInteraction, IAuthStatus } from "@/authentication"
import type { IAuthenticationProvider, IAuthStore } from "@/authentication"
import { createDeepSeekFetch } from "@/providers/deepseek/transport/deepseek-fetch"

export interface IDeepSeekAuthOptions {
    readonly store: IAuthStore
    readonly signal?: AbortSignal
    readonly fetch?: typeof fetch
}

export class DeepSeekAuth implements IAuthenticationProvider {
    readonly id = "deepseek"
    readonly name = "DeepSeek"
    readonly methods = [{
        id: "api-key",
        name: "API key",
        description: "Store a DeepSeek API key locally (not verified online)",
    }] as const

    readonly authenticatedFetch: typeof fetch

    private readonly lifetime = new AbortController()
    private readonly operations = new Set<Promise<unknown>>()
    private activeLogin: AbortController | undefined
    private disposePromise: Promise<void> | undefined
    private removeRootListener: (() => void) | undefined

    constructor(private readonly options: IDeepSeekAuthOptions) {
        const transport = createDeepSeekFetch({
            fetch: options.fetch ?? globalThis.fetch,
            signal: this.lifetime.signal,
            requireApiKey: async (signal) => {
                const credential = await this.options.store.get(this.id, signal)
                signal.throwIfAborted()
                if (!credential || credential.type !== "api_key") {
                    throw new Error("DeepSeek requires a stored API key")
                }
                return validateApiKey(credential.key)
            },
            trackBody: (completion) => {
                this.operations.add(completion)
                void completion.then(() => this.operations.delete(completion))
            },
        })
        this.authenticatedFetch = Object.assign(
            (input: RequestInfo | URL, init?: RequestInit) => this.track(() => transport(input, init)),
            { preconnect: transport.preconnect },
        )
        const signal = options.signal
        if (signal) {
            const abort = () => { void this.dispose(signal.reason) }
            if (signal.aborted) abort()
            else {
                signal.addEventListener("abort", abort, { once: true })
                this.removeRootListener = () => signal.removeEventListener("abort", abort)
            }
        }
    }

    readonly status = (signal?: AbortSignal): Promise<IAuthStatus> => this.track(async () => {
        const operationSignal = this.signal(signal)
        const credential = await this.options.store.get(this.id, operationSignal)
        operationSignal.throwIfAborted()
        if (credential) {
            if (credential.type !== "api_key") throw new Error("DeepSeek requires an API key")
            validateApiKey(credential.key)
        }
        return { providerId: this.id, connected: credential !== undefined }
    })

    readonly login = (methodId: string, interaction: IAuthInteraction): Promise<IAuthStatus> => this.track(async () => {
        this.signal(interaction.signal).throwIfAborted()
        if (methodId !== "api-key") throw new Error("Unsupported DeepSeek authentication method")
        this.activeLogin?.abort(new Error("DeepSeek login was replaced"))
        const controller = new AbortController()
        this.activeLogin = controller
        const signal = AbortSignal.any([this.signal(interaction.signal), controller.signal])
        try {
            const operation = await this.options.store.beginOperation(this.id, signal)
            signal.throwIfAborted()
            const input = await interaction.prompt({
                type: "secret",
                message: "Enter your DeepSeek API key (stored locally; not verified online):",
                placeholder: "API key",
                signal,
            })
            signal.throwIfAborted()
            const key = validateApiKey(input)
            const committed = await this.options.store.commitOperation(
                this.id, operation, { type: "api_key", key }, signal,
            )
            signal.throwIfAborted()
            if (!committed) throw new Error("DeepSeek login was replaced")
            return { providerId: this.id, connected: true }
        } finally {
            if (this.activeLogin === controller) this.activeLogin = undefined
        }
    })

    readonly logout = (signal: AbortSignal): Promise<boolean> => this.track(async () => {
        const operationSignal = this.signal(signal)
        this.activeLogin?.abort(new Error("DeepSeek login was cancelled by logout"))
        this.activeLogin = undefined
        return this.options.store.remove(this.id, operationSignal)
    })

    readonly dispose = (reason: unknown = new Error("DeepSeek authentication is shutting down")): Promise<void> => {
        if (this.disposePromise) return this.disposePromise
        const completion = Promise.withResolvers<void>()
        this.disposePromise = completion.promise
        this.removeRootListener?.()
        this.removeRootListener = undefined
        this.lifetime.abort(reason)
        this.activeLogin?.abort(reason)
        this.activeLogin = undefined
        void Promise.allSettled([...this.operations]).then(() => completion.resolve())
        return this.disposePromise
    }

    private signal(signal?: AbortSignal): AbortSignal {
        this.lifetime.signal.throwIfAborted()
        signal?.throwIfAborted()
        return signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal
    }

    private track<T>(run: () => Promise<T>): Promise<T> {
        if (this.lifetime.signal.aborted) return Promise.reject(this.lifetime.signal.reason)
        const completion = Promise.withResolvers<T>()
        this.operations.add(completion.promise)
        try {
            void run().then(completion.resolve, completion.reject)
        } catch (error) {
            completion.reject(error)
        }
        void completion.promise.then(
            () => this.operations.delete(completion.promise),
            () => this.operations.delete(completion.promise),
        )
        return completion.promise
    }
}

function validateApiKey(input: string): string {
    const key = input.trim()
    if (!key || /[\s\u0000-\u001f\u007f]/u.test(key)) {
        throw new Error("Invalid DeepSeek API key format")
    }
    return key
}
