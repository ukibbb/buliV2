import type {
    IAuthMethodInfo,
    IAuthPrompt,
    IAuthProviderInfo,
    IAuthenticationService,
    TAuthEvent,
} from "@/authentication/contracts"
import type {
    TAuthenticationMode,
    TAuthenticationOutcome,
} from "@/authentication/ui/types"

interface IProviderState {
    readonly providers: readonly IAuthProviderInfo[]
}

export type TAuthenticationFlowState =
    | { readonly type: "loading" }
    | ({ readonly type: "providers" } & IProviderState)
    | ({
        readonly type: "methods"
        readonly provider: IAuthProviderInfo
    } & IProviderState)
    | ({
        readonly type: "confirm"
        readonly provider: IAuthProviderInfo
    } & IProviderState)
    | ({
        readonly type: "login"
        readonly provider: IAuthProviderInfo
        readonly method: IAuthMethodInfo
        readonly operationId: number
        readonly event?: TAuthEvent
        readonly prompt?: IAuthPromptView
        readonly browserOpenFailed: boolean
    } & IProviderState)
    | ({
        readonly type: "logout"
        readonly provider: IAuthProviderInfo
        readonly operationId: number
    } & IProviderState)
    | {
        readonly type: "success"
        readonly mode: TAuthenticationMode
        readonly providerName: string
        readonly accountId?: string
    }
    | ({
        readonly type: "error"
        readonly message: string
        readonly retry: TAuthenticationRetry
    } & Partial<IProviderState>)

export interface IAuthPromptView {
    // Każdy prompt dostaje nowe ID, aby widok mógł zamontować pusty input
    // bez przekazywania imperatywnego InputRenderable do kontrolera.
    readonly id: number
    readonly message: string
    readonly placeholder: string
}

type TAuthenticationRetry =
    | { readonly type: "providers" }
    | {
        readonly type: "login"
        readonly provider: IAuthProviderInfo
        readonly method: IAuthMethodInfo
    }
    | {
        readonly type: "logout"
        readonly provider: IAuthProviderInfo
    }

interface IActiveOperation {
    readonly id: number
    readonly controller: AbortController
}

interface IPendingPrompt {
    readonly operationId: number
    readonly signal: AbortSignal
    readonly resolve: (value: string) => void
    readonly reject: (reason?: unknown) => void
    readonly onAbort: () => void
}

export interface IAuthenticationFlowControllerOptions {
    readonly mode: TAuthenticationMode
    readonly authentication: IAuthenticationService
    readonly onClose: (outcome: TAuthenticationOutcome) => void
    readonly openUrl: (url: string) => unknown | Promise<unknown>
}

type TAuthenticationFlowListener = () => void

/** Owns authentication navigation and async operations without depending on React. */
/** Owns navigation, async operations and cancellation for one auth screen. */
export class AuthenticationFlowController {
    readonly mode: TAuthenticationMode

    private readonly authentication: IAuthenticationService
    private readonly onClose: (outcome: TAuthenticationOutcome) => void
    private readonly openUrl: (url: string) => unknown | Promise<unknown>
    private readonly listeners = new Set<TAuthenticationFlowListener>()
    private snapshot: TAuthenticationFlowState = { type: "loading" }
    private loadController: AbortController | undefined
    private activeOperation: IActiveOperation | undefined
    private pendingPrompt: IPendingPrompt | undefined
    private nextOperationId = 0
    private nextPromptId = 0
    private hadFailure = false
    private started = false
    private disposed = false
    private closed = false

    constructor(options: IAuthenticationFlowControllerOptions) {
        this.mode = options.mode
        this.authentication = options.authentication
        this.onClose = options.onClose
        this.openUrl = options.openUrl
    }

    readonly getSnapshot = (): TAuthenticationFlowState => this.snapshot

    readonly subscribe = (
        listener: TAuthenticationFlowListener,
    ): (() => void) => {
        if (this.disposed) return () => {}
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
    }

    readonly start = (): void => {
        if (this.started || this.disposed) return
        this.started = true
        this.loadProviders()
    }

    readonly dispose = (
        reason: unknown = new Error("Authentication screen unmounted"),
    ): void => {
        if (this.disposed) return
        this.stop(reason)
    }

    readonly close = (outcome?: TAuthenticationOutcome): void => {
        if (this.closed || this.disposed) return
        // Ustawiamy flagę przed callbackiem, ponieważ onClose może reentrantnie
        // wywołać close podczas zamykania nadrzędnego renderera.
        this.closed = true
        this.stop(new Error("Authentication screen closed"))
        this.onClose(outcome ?? (this.hadFailure ? "failure" : "cancelled"))
    }

    readonly selectProvider = (providerId: string): void => {
        if (this.disposed) return
        const state = this.snapshot
        if (state.type !== "providers") return
        const provider = state.providers.find(
            (candidate) => candidate.providerId === providerId,
        )
        if (!provider) return
        this.publish(this.mode === "login"
            ? { type: "methods", providers: state.providers, provider }
            : { type: "confirm", providers: state.providers, provider })
    }

    readonly selectMethod = (methodId: string): void => {
        if (this.disposed) return
        const state = this.snapshot
        if (state.type !== "methods") return
        const method = state.provider.methods.find(
            (candidate) => candidate.id === methodId,
        )
        if (method) this.beginLogin(state.providers, state.provider, method)
    }

    readonly confirmLogout = (): void => {
        if (this.disposed) return
        const state = this.snapshot
        if (state.type !== "confirm") return
        this.beginLogout(state.providers, state.provider)
    }

    readonly retry = (): void => {
        if (this.disposed) return
        const state = this.snapshot
        if (state.type !== "error") return
        const retryState = state.retry
        if (retryState.type === "providers") {
            this.loadProviders()
            return
        }
        const providers = state.providers ?? []
        if (retryState.type === "login") {
            this.beginLogin(providers, retryState.provider, retryState.method)
            return
        }
        this.beginLogout(providers, retryState.provider)
    }

    readonly back = (): void => {
        if (this.disposed) return
        const state = this.snapshot
        if (state.type === "methods" || state.type === "confirm") {
            this.publish({ type: "providers", providers: state.providers })
            return
        }
        if (state.type === "login") {
            this.cancelActiveOperation("Login was cancelled")
            this.publish({
                type: "methods",
                providers: state.providers,
                provider: state.provider,
            })
            return
        }
        if (state.type === "logout") {
            this.cancelActiveOperation("Logout was cancelled")
            this.publish({
                type: "confirm",
                providers: state.providers,
                provider: state.provider,
            })
            return
        }
        if (state.type === "error") this.backFromError(state)
    }

    readonly cancel = (): void => {
        if (this.disposed) return
        const state = this.snapshot
        if (state.type === "success") {
            this.close("success")
            return
        }
        if (state.type === "loading" || state.type === "providers") {
            this.close()
            return
        }
        this.back()
    }

    readonly submitPrompt = (value: string): void => {
        if (this.disposed) return
        const pending = this.pendingPrompt
        const input = value.trim()
        if (
            !pending
            || !input
            || this.activeOperation?.id !== pending.operationId
        ) return
        this.pendingPrompt = undefined
        pending.signal.removeEventListener("abort", pending.onAbort)
        this.updateLoginState(pending.operationId, (current) => {
            const { prompt: _prompt, ...withoutPrompt } = current
            return withoutPrompt
        })
        pending.resolve(input)
    }

    private loadProviders(): void {
        if (this.disposed) return
        this.loadController?.abort(new Error("Provider loading was replaced"))
        const controller = new AbortController()
        this.loadController = controller
        this.publish({ type: "loading" })

        void this.authentication.listProviders(controller.signal).then(
            (providers) => {
                if (
                    controller.signal.aborted
                    || this.loadController !== controller
                    || this.disposed
                ) return
                this.loadController = undefined
                this.publish({
                    type: "providers",
                    providers: this.mode === "logout"
                        ? [...providers].sort((left, right) =>
                            Number(Boolean(right.connected || right.statusError))
                            - Number(Boolean(left.connected || left.statusError))
                        )
                        : providers,
                })
            },
            () => {
                if (
                    controller.signal.aborted
                    || this.loadController !== controller
                    || this.disposed
                ) return
                this.loadController = undefined
                this.hadFailure = true
                this.publish({
                    type: "error",
                    message: "Could not load authentication providers.",
                    retry: { type: "providers" },
                })
            },
        )
    }

    private beginLogin(
        providers: readonly IAuthProviderInfo[],
        provider: IAuthProviderInfo,
        method: IAuthMethodInfo,
    ): void {
        if (this.disposed) return
        this.cancelActiveOperation("Authentication operation was replaced")
        const controller = new AbortController()
        const operationId = ++this.nextOperationId
        this.activeOperation = { id: operationId, controller }
        this.publish({
            type: "login",
            providers,
            provider,
            method,
            operationId,
            browserOpenFailed: false,
        })

        const notify = (event: TAuthEvent): void => {
            controller.signal.throwIfAborted()
            this.updateLoginState(operationId, (current) => ({ ...current, event }))
            if (event.type === "progress") return

            void Promise.resolve()
                .then(() => this.openUrl(event.url))
                .catch(() => {
                    this.updateLoginState(operationId, (current) => ({
                        ...current,
                        browserOpenFailed: true,
                    }))
                })
        }

        const prompt = (request: IAuthPrompt): Promise<string> => {
            return new Promise<string>((resolve, reject) => {
                if (
                    request.signal.aborted
                    || controller.signal.aborted
                    || this.activeOperation?.id !== operationId
                ) {
                    reject(abortReason(request.signal, "Authentication was cancelled"))
                    return
                }

                this.rejectPendingPrompt(new Error("Authentication prompt was replaced"))
                let pending: IPendingPrompt
                const onAbort = (): void => {
                    if (this.pendingPrompt !== pending) return
                    this.pendingPrompt = undefined
                    request.signal.removeEventListener("abort", onAbort)
                    this.updateLoginState(operationId, (current) => {
                        const { prompt: _prompt, ...withoutPrompt } = current
                        return withoutPrompt
                    })
                    reject(abortReason(request.signal, "Authentication was cancelled"))
                }
                pending = {
                    operationId,
                    signal: request.signal,
                    resolve,
                    reject,
                    onAbort,
                }
                this.pendingPrompt = pending
                request.signal.addEventListener("abort", onAbort, { once: true })
                if (request.signal.aborted) {
                    onAbort()
                    return
                }
                this.updateLoginState(operationId, (current) => ({
                    ...current,
                    prompt: {
                        id: ++this.nextPromptId,
                        message: request.message,
                        placeholder: request.placeholder,
                    },
                }))
            })
        }

        void this.authentication.login(provider.providerId, method.id, {
            signal: controller.signal,
            notify,
            prompt,
        }).then(
            (status) => {
                if (
                    controller.signal.aborted
                    || this.activeOperation?.id !== operationId
                    || this.disposed
                ) return
                this.activeOperation = undefined
                this.rejectPendingPrompt(new Error("Authentication completed"))
                this.publish({
                    type: "success",
                    mode: "login",
                    providerName: provider.name,
                    ...(status.accountId ? { accountId: status.accountId } : {}),
                })
            },
            () => {
                if (
                    controller.signal.aborted
                    || this.activeOperation?.id !== operationId
                    || this.disposed
                ) return
                this.activeOperation = undefined
                this.hadFailure = true
                this.rejectPendingPrompt(new Error("Authentication failed"))
                this.publish({
                    type: "error",
                    providers,
                    message: `Could not sign in to ${provider.name}.`,
                    retry: { type: "login", provider, method },
                })
            },
        )
    }

    private beginLogout(
        providers: readonly IAuthProviderInfo[],
        provider: IAuthProviderInfo,
    ): void {
        if (this.disposed) return
        this.cancelActiveOperation("Authentication operation was replaced")
        const controller = new AbortController()
        const operationId = ++this.nextOperationId
        this.activeOperation = { id: operationId, controller }
        this.publish({ type: "logout", providers, provider, operationId })

        void this.authentication.logout(
            provider.providerId,
            controller.signal,
        ).then(
            () => {
                if (
                    controller.signal.aborted
                    || this.activeOperation?.id !== operationId
                    || this.disposed
                ) return
                this.activeOperation = undefined
                this.publish({
                    type: "success",
                    mode: "logout",
                    providerName: provider.name,
                    ...(provider.accountId
                        ? { accountId: provider.accountId }
                        : {}),
                })
            },
            () => {
                if (
                    controller.signal.aborted
                    || this.activeOperation?.id !== operationId
                    || this.disposed
                ) return
                this.activeOperation = undefined
                this.hadFailure = true
                this.publish({
                    type: "error",
                    providers,
                    message: `Could not disconnect ${provider.name}.`,
                    retry: { type: "logout", provider },
                })
            },
        )
    }

    private backFromError(
        state: Extract<TAuthenticationFlowState, { type: "error" }>,
    ): void {
        if (state.retry.type === "providers") {
            this.close()
            return
        }
        const providers = state.providers ?? []
        if (state.retry.type === "login") {
            this.publish({
                type: "methods",
                providers,
                provider: state.retry.provider,
            })
            return
        }
        this.publish({
            type: "confirm",
            providers,
            provider: state.retry.provider,
        })
    }

    private updateLoginState(
        operationId: number,
        update: (
            current: Extract<TAuthenticationFlowState, { type: "login" }>,
        ) => Extract<TAuthenticationFlowState, { type: "login" }>,
    ): void {
        if (this.disposed || this.activeOperation?.id !== operationId) return
        const current = this.snapshot
        if (current.type !== "login" || current.operationId !== operationId) return
        this.publish(update(current))
    }

    private rejectPendingPrompt(reason: unknown): void {
        const pending = this.pendingPrompt
        if (!pending) return
        this.pendingPrompt = undefined
        pending.signal.removeEventListener("abort", pending.onAbort)
        pending.reject(reason)
    }

    private cancelActiveOperation(reason: unknown): void {
        const active = this.activeOperation
        this.activeOperation = undefined
        const cancellation = reason instanceof Error
            ? reason
            : new Error(String(reason))
        this.rejectPendingPrompt(cancellation)
        active?.controller.abort(cancellation)
    }

    private stop(reason: unknown): void {
        this.disposed = true
        this.loadController?.abort(reason)
        this.loadController = undefined
        this.cancelActiveOperation(reason)
        this.listeners.clear()
    }

    private publish(snapshot: TAuthenticationFlowState): void {
        if (this.disposed) return
        this.snapshot = snapshot
        for (const listener of this.listeners) listener()
    }
}

function abortReason(signal: AbortSignal, fallback: string): unknown {
    return signal.aborted ? signal.reason : new Error(fallback)
}
