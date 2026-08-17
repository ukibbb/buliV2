import type {
    InputRenderable,
    ScrollBoxRenderable,
    SelectOption,
} from "@opentui/core"
import { useKeyboard } from "@opentui/react"
import open from "open"
import { useEffect, useRef, useState, type ReactNode } from "react"

import type {
    IAuthMethodInfo,
    IAuthPrompt,
    IAuthProviderInfo,
    IAuthenticationService,
    TAuthenticationMode,
    TAuthenticationOutcome,
    TAuthEvent,
} from "@/auth/contracts"
import { theme } from "@/tui/theme"

interface IAuthenticationFlowProps {
    readonly mode: TAuthenticationMode
    readonly authentication: IAuthenticationService
    readonly onClose: (outcome: TAuthenticationOutcome) => void
    readonly openUrl?: (url: string) => unknown | Promise<unknown>
}

interface IProviderState {
    readonly providers: readonly IAuthProviderInfo[]
}

type TAuthenticationFlowState =
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

interface IAuthPromptView {
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

const RETRY_OPTIONS: SelectOption[] = [
    { name: "Retry", description: "Try the operation again" },
    { name: "Back", description: "Return to the previous step" },
]

const CONFIRM_OPTIONS: SelectOption[] = [
    { name: "Disconnect", description: "Remove the saved connection" },
    { name: "Back", description: "Keep this provider connected" },
]

export function AuthenticationFlow(
    props: IAuthenticationFlowProps,
): ReactNode {
    const [state, setState] = useState<TAuthenticationFlowState>({
        type: "loading",
    })
    const mountedRef = useRef(false)
    const loadRef = useRef<AbortController | undefined>(undefined)
    const activeRef = useRef<IActiveOperation | undefined>(undefined)
    const pendingPromptRef = useRef<IPendingPrompt | undefined>(undefined)
    const promptInputRef = useRef<InputRenderable | null>(null)
    const loginScrollRef = useRef<ScrollBoxRenderable | null>(null)
    const nextOperationIdRef = useRef(0)
    const hadFailureRef = useRef(false)

    const rejectPendingPrompt = (reason: unknown): void => {
        const pending = pendingPromptRef.current
        if (!pending) return
        pendingPromptRef.current = undefined
        pending.signal.removeEventListener("abort", pending.onAbort)
        promptInputRef.current?.clear()
        pending.reject(reason)
    }

    const cancelActiveOperation = (message: string): void => {
        const active = activeRef.current
        activeRef.current = undefined
        const reason = new Error(message)
        rejectPendingPrompt(reason)
        active?.controller.abort(reason)
    }

    const loadProviders = (): void => {
        loadRef.current?.abort(new Error("Provider loading was replaced"))
        const controller = new AbortController()
        loadRef.current = controller
        setState({ type: "loading" })

        void props.authentication.listProviders(controller.signal).then(
            (providers) => {
                if (
                    controller.signal.aborted
                    || loadRef.current !== controller
                    || !mountedRef.current
                ) return
                loadRef.current = undefined
                setState({
                    type: "providers",
                    providers: props.mode === "logout"
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
                    || loadRef.current !== controller
                    || !mountedRef.current
                ) return
                loadRef.current = undefined
                hadFailureRef.current = true
                setState({
                    type: "error",
                    message: "Could not load authentication providers.",
                    retry: { type: "providers" },
                })
            },
        )
    }

    const beginLogin = (
        providers: readonly IAuthProviderInfo[],
        provider: IAuthProviderInfo,
        method: IAuthMethodInfo,
    ): void => {
        cancelActiveOperation("Authentication operation was replaced")
        const controller = new AbortController()
        const operationId = ++nextOperationIdRef.current
        activeRef.current = { id: operationId, controller }
        setState({
            type: "login",
            providers,
            provider,
            method,
            operationId,
            browserOpenFailed: false,
        })

        const updateLoginState = (
            update: (
                current: Extract<TAuthenticationFlowState, { type: "login" }>,
            ) => Extract<TAuthenticationFlowState, { type: "login" }>,
        ): void => {
            if (!mountedRef.current || activeRef.current?.id !== operationId) return
            setState((current) => {
                if (
                    current.type !== "login"
                    || current.operationId !== operationId
                ) return current
                return update(current)
            })
        }

        const notify = (event: TAuthEvent): void => {
            controller.signal.throwIfAborted()
            updateLoginState((current) => ({ ...current, event }))
            if (event.type === "progress") return

            void Promise.resolve()
                .then(() => (props.openUrl ?? open)(event.url))
                .catch(() => {
                    updateLoginState((current) => ({
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
                    || activeRef.current?.id !== operationId
                ) {
                    reject(abortReason(request.signal, "Authentication was cancelled"))
                    return
                }

                rejectPendingPrompt(new Error("Authentication prompt was replaced"))
                let pending: IPendingPrompt
                const onAbort = (): void => {
                    if (pendingPromptRef.current !== pending) return
                    pendingPromptRef.current = undefined
                    request.signal.removeEventListener("abort", onAbort)
                    promptInputRef.current?.clear()
                    if (mountedRef.current) {
                        updateLoginState((current) => {
                            const { prompt: _prompt, ...withoutPrompt } = current
                            return withoutPrompt
                        })
                    }
                    reject(abortReason(request.signal, "Authentication was cancelled"))
                }
                pending = {
                    operationId,
                    signal: request.signal,
                    resolve,
                    reject,
                    onAbort,
                }
                pendingPromptRef.current = pending
                request.signal.addEventListener("abort", onAbort, { once: true })
                if (request.signal.aborted) {
                    onAbort()
                    return
                }
                updateLoginState((current) => ({
                    ...current,
                    prompt: {
                        message: request.message,
                        placeholder: request.placeholder,
                    },
                }))
            })
        }

        void props.authentication.login(provider.providerId, method.id, {
            signal: controller.signal,
            notify,
            prompt,
        }).then(
            (status) => {
                if (
                    controller.signal.aborted
                    || activeRef.current?.id !== operationId
                    || !mountedRef.current
                ) return
                activeRef.current = undefined
                rejectPendingPrompt(new Error("Authentication completed"))
                setState({
                    type: "success",
                    mode: "login",
                    providerName: provider.name,
                    ...(status.accountId ? { accountId: status.accountId } : {}),
                })
            },
            () => {
                if (
                    controller.signal.aborted
                    || activeRef.current?.id !== operationId
                    || !mountedRef.current
                ) return
                activeRef.current = undefined
                hadFailureRef.current = true
                rejectPendingPrompt(new Error("Authentication failed"))
                setState({
                    type: "error",
                    providers,
                    message: `Could not sign in to ${provider.name}.`,
                    retry: { type: "login", provider, method },
                })
            },
        )
    }

    const beginLogout = (
        providers: readonly IAuthProviderInfo[],
        provider: IAuthProviderInfo,
    ): void => {
        cancelActiveOperation("Authentication operation was replaced")
        const controller = new AbortController()
        const operationId = ++nextOperationIdRef.current
        activeRef.current = { id: operationId, controller }
        setState({ type: "logout", providers, provider, operationId })

        void props.authentication.logout(
            provider.providerId,
            controller.signal,
        ).then(
            () => {
                if (
                    controller.signal.aborted
                    || activeRef.current?.id !== operationId
                    || !mountedRef.current
                ) return
                activeRef.current = undefined
                setState({
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
                    || activeRef.current?.id !== operationId
                    || !mountedRef.current
                ) return
                activeRef.current = undefined
                hadFailureRef.current = true
                setState({
                    type: "error",
                    providers,
                    message: `Could not disconnect ${provider.name}.`,
                    retry: { type: "logout", provider },
                })
            },
        )
    }

    const close = (outcome?: TAuthenticationOutcome): void => {
        loadRef.current?.abort(new Error("Authentication screen closed"))
        loadRef.current = undefined
        cancelActiveOperation("Authentication screen closed")
        props.onClose(
            outcome ?? (hadFailureRef.current ? "failure" : "cancelled"),
        )
    }

    const backFromError = (
        errorState: Extract<TAuthenticationFlowState, { type: "error" }>,
    ): void => {
        if (errorState.retry.type === "providers") {
            close()
            return
        }
        const providers = errorState.providers ?? []
        if (errorState.retry.type === "login") {
            setState({
                type: "methods",
                providers,
                provider: errorState.retry.provider,
            })
            return
        }
        setState({
            type: "confirm",
            providers,
            provider: errorState.retry.provider,
        })
    }

    const retry = (
        errorState: Extract<TAuthenticationFlowState, { type: "error" }>,
    ): void => {
        const retryState = errorState.retry
        if (retryState.type === "providers") {
            loadProviders()
            return
        }
        const providers = errorState.providers ?? []
        if (retryState.type === "login") {
            beginLogin(providers, retryState.provider, retryState.method)
            return
        }
        beginLogout(providers, retryState.provider)
    }

    const submitPrompt = (value: string): void => {
        const pending = pendingPromptRef.current
        const input = value.trim()
        if (!pending || !input || activeRef.current?.id !== pending.operationId) return
        pendingPromptRef.current = undefined
        pending.signal.removeEventListener("abort", pending.onAbort)
        promptInputRef.current?.clear()
        setState((current) => {
            if (
                current.type !== "login"
                || current.operationId !== pending.operationId
            ) return current
            const { prompt: _prompt, ...withoutPrompt } = current
            return withoutPrompt
        })
        pending.resolve(input)
    }

    useEffect(() => {
        mountedRef.current = true
        loadProviders()
        return () => {
            mountedRef.current = false
            loadRef.current?.abort(new Error("Authentication screen unmounted"))
            loadRef.current = undefined
            cancelActiveOperation("Authentication screen unmounted")
        }
    }, [props.authentication, props.mode])

    useKeyboard((key) => {
        if (
            state.type === "login"
            && (key.name === "pageup" || key.name === "pagedown")
        ) {
            key.preventDefault()
            key.stopPropagation()
            loginScrollRef.current?.scrollBy(
                key.name === "pageup" ? -1 : 1,
                "viewport",
            )
            return
        }

        const isEscape = key.name === "escape"
        const isEnter = key.name === "return" || key.name === "enter"
            || key.name === "linefeed"
        const isEmptyProviderList = state.type === "providers"
            && state.providers.length === 0
        if (
            !isEscape
            && !(state.type === "success" && isEnter)
            && !(isEmptyProviderList && isEnter)
        ) return

        key.preventDefault()
        key.stopPropagation()
        if (state.type === "success") {
            close("success")
            return
        }
        if (state.type === "loading") {
            close()
            return
        }
        if (state.type === "providers") {
            close(isEmptyProviderList && isEnter ? "success" : undefined)
            return
        }
        if (state.type === "methods" || state.type === "confirm") {
            setState({ type: "providers", providers: state.providers })
            return
        }
        if (state.type === "login") {
            cancelActiveOperation("Login was cancelled")
            setState({
                type: "methods",
                providers: state.providers,
                provider: state.provider,
            })
            return
        }
        if (state.type === "logout") {
            cancelActiveOperation("Logout was cancelled")
            setState({
                type: "confirm",
                providers: state.providers,
                provider: state.provider,
            })
            return
        }
        backFromError(state)
    })

    const providerOptions = state.type === "providers"
        ? state.providers.map((provider): SelectOption => ({
            name: provider.name,
            description: provider.statusError
                ? "Authentication needs repair"
                : provider.connected
                ? `Connected${provider.accountId ? ` as ${provider.accountId}` : ""}`
                : "Not connected",
        }))
        : []
    const methodOptions = state.type === "methods"
        ? state.provider.methods.map((method): SelectOption => ({
            name: method.name,
            description: method.description,
        }))
        : []

    return (
        <box
            width="100%"
            minHeight={0}
            flexGrow={1}
            alignItems="center"
            justifyContent="center"
            padding={1}
        >
            <box
                width="100%"
                maxWidth={76}
                maxHeight="100%"
                flexDirection="column"
                border
                borderStyle="single"
                borderColor={theme.textMuted}
                padding={1}
                gap={1}
            >
                <text fg={theme.green}>Buli Authentication</text>
                <text fg={theme.textMuted}>
                    {props.mode === "login" ? "Sign in" : "Sign out"}
                </text>

                {state.type === "loading" ? (
                    <text fg={theme.textMuted}>Loading providers...</text>
                ) : null}

                {state.type === "providers" ? (
                    <box flexDirection="column" gap={1}>
                        <text>Select a provider</text>
                        {state.providers.length > 0 ? (
                            <select
                                focused
                                options={providerOptions}
                                height={selectHeight(providerOptions.length)}
                                wrapSelection
                                showDescription
                                backgroundColor="transparent"
                                focusedBackgroundColor="transparent"
                                textColor={theme.text}
                                focusedTextColor={theme.text}
                                selectedBackgroundColor={theme.green}
                                selectedTextColor={theme.text}
                                descriptionColor={theme.textMuted}
                                selectedDescriptionColor={theme.text}
                                onSelect={(index) => {
                                    const provider = state.providers[index]
                                    if (!provider) return
                                    setState(props.mode === "login"
                                        ? {
                                            type: "methods",
                                            providers: state.providers,
                                            provider,
                                        }
                                        : {
                                            type: "confirm",
                                            providers: state.providers,
                                            provider,
                                        })
                                }}
                            />
                        ) : (
                            <text fg={theme.textMuted}>
                                {props.mode === "login"
                                    ? "No authentication providers are available."
                                    : "No authentication providers are available."}
                            </text>
                        )}
                        <text fg={theme.textMuted}>
                            {state.providers.length > 0
                                ? "enter select  esc close"
                                : "enter or esc close"}
                        </text>
                    </box>
                ) : null}

                {state.type === "methods" ? (
                    <box flexDirection="column" gap={1}>
                        <text>{state.provider.name}</text>
                        <text>Select a login method</text>
                        {state.provider.methods.length > 0 ? (
                            <select
                                focused
                                options={methodOptions}
                                height={selectHeight(methodOptions.length)}
                                wrapSelection
                                showDescription
                                backgroundColor="transparent"
                                focusedBackgroundColor="transparent"
                                textColor={theme.text}
                                focusedTextColor={theme.text}
                                selectedBackgroundColor={theme.green}
                                selectedTextColor={theme.text}
                                descriptionColor={theme.textMuted}
                                selectedDescriptionColor={theme.text}
                                onSelect={(index) => {
                                    const method = state.provider.methods[index]
                                    if (method) {
                                        beginLogin(
                                            state.providers,
                                            state.provider,
                                            method,
                                        )
                                    }
                                }}
                            />
                        ) : (
                            <text fg={theme.textMuted}>
                                No login methods are available for this provider.
                            </text>
                        )}
                        <text fg={theme.textMuted}>enter select  esc back</text>
                    </box>
                ) : null}

                {state.type === "confirm" ? (
                    <box flexDirection="column" gap={1}>
                        <text>{`Disconnect ${state.provider.name}?`}</text>
                        <text fg={theme.textMuted}>
                            {`Account: ${state.provider.accountId ?? "unavailable"}`}
                        </text>
                        <select
                            focused
                            options={CONFIRM_OPTIONS}
                            height={selectHeight(CONFIRM_OPTIONS.length)}
                            wrapSelection
                            showDescription
                            backgroundColor="transparent"
                            focusedBackgroundColor="transparent"
                            textColor={theme.text}
                            focusedTextColor={theme.text}
                            selectedBackgroundColor={theme.green}
                            selectedTextColor={theme.text}
                            descriptionColor={theme.textMuted}
                            selectedDescriptionColor={theme.text}
                            onSelect={(index) => {
                                if (index === 0) {
                                    beginLogout(state.providers, state.provider)
                                } else {
                                    setState({
                                        type: "providers",
                                        providers: state.providers,
                                    })
                                }
                            }}
                        />
                        <text fg={theme.textMuted}>enter select  esc back</text>
                    </box>
                ) : null}

                {state.type === "login" ? (
                    <scrollbox
                        ref={loginScrollRef}
                        height={14}
                        scrollY
                        stickyScroll
                        stickyStart="bottom"
                        viewportCulling={false}
                        verticalScrollbarOptions={{ visible: false }}
                        contentOptions={{ flexDirection: "column", gap: 1 }}
                    >
                        <text>{`Signing in to ${state.provider.name}...`}</text>
                        {state.event ? <AuthenticationEvent event={state.event} /> : (
                            <text fg={theme.textMuted}>Starting authentication...</text>
                        )}
                        {state.browserOpenFailed ? (
                            <text fg={theme.amber}>
                                Could not open the browser automatically. Use the URL above.
                            </text>
                        ) : null}
                        {state.prompt ? (
                            <box flexDirection="column" gap={1}>
                                <text>{state.prompt.message}</text>
                                <box border={["bottom"]} borderColor={theme.textMuted}>
                                    <input
                                        ref={promptInputRef}
                                        focused
                                        placeholder={state.prompt.placeholder}
                                        textColor={theme.text}
                                        focusedTextColor={theme.text}
                                        placeholderColor={theme.textMuted}
                                        backgroundColor="transparent"
                                        focusedBackgroundColor="transparent"
                                        onSubmit={() => {
                                            submitPrompt(
                                                promptInputRef.current?.value ?? "",
                                            )
                                        }}
                                    />
                                </box>
                                <text fg={theme.textMuted}>enter submit  esc cancel</text>
                            </box>
                        ) : (
                            <text fg={theme.textMuted}>Waiting...  esc cancel</text>
                        )}
                        <text fg={theme.textMuted}>page up/down scroll</text>
                    </scrollbox>
                ) : null}

                {state.type === "logout" ? (
                    <box flexDirection="column" gap={1}>
                        <text>{`Disconnecting ${state.provider.name}...`}</text>
                        <text fg={theme.textMuted}>Please wait  esc cancel</text>
                    </box>
                ) : null}

                {state.type === "success" ? (
                    <box flexDirection="column" gap={1}>
                        <text fg={theme.green}>
                            {state.mode === "login"
                                ? "Sign-in complete"
                                : "Sign-out complete"}
                        </text>
                        <text>{`Provider: ${state.providerName}`}</text>
                        <text>{`Account: ${state.accountId ?? "unavailable"}`}</text>
                        <text fg={theme.textMuted}>enter or esc close</text>
                    </box>
                ) : null}

                {state.type === "error" ? (
                    <box flexDirection="column" gap={1}>
                        <text fg={theme.red}>{state.message}</text>
                        <select
                            focused
                            options={RETRY_OPTIONS}
                            height={selectHeight(RETRY_OPTIONS.length)}
                            wrapSelection
                            showDescription
                            backgroundColor="transparent"
                            focusedBackgroundColor="transparent"
                            textColor={theme.text}
                            focusedTextColor={theme.text}
                            selectedBackgroundColor={theme.green}
                            selectedTextColor={theme.text}
                            descriptionColor={theme.textMuted}
                            selectedDescriptionColor={theme.text}
                            onSelect={(index) => {
                                if (index === 0) retry(state)
                                else backFromError(state)
                            }}
                        />
                        <text fg={theme.textMuted}>enter select  esc back</text>
                    </box>
                ) : null}
            </box>
        </box>
    )
}

function AuthenticationEvent(props: { readonly event: TAuthEvent }): ReactNode {
    if (props.event.type === "progress") {
        return <text fg={theme.textMuted}>{props.event.message}</text>
    }
    if (props.event.type === "authorization") {
        return (
            <box flexDirection="column" gap={1}>
                <text>{props.event.instructions}</text>
                <text fg={theme.green} wrapMode="word">{props.event.url}</text>
            </box>
        )
    }
    return (
        <box flexDirection="column" gap={1}>
            <text>{props.event.instructions}</text>
            <text fg={theme.green} wrapMode="word">{props.event.url}</text>
            <text>{`Device code: ${props.event.userCode}`}</text>
        </box>
    )
}

function selectHeight(optionCount: number): number {
    return Math.max(3, Math.min(optionCount * 2, 10))
}

function abortReason(signal: AbortSignal, fallback: string): unknown {
    return signal.aborted ? signal.reason : new Error(fallback)
}
