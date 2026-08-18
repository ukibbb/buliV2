import type {
    InputRenderable,
    ScrollBoxRenderable,
    SelectOption,
} from "@opentui/core"
import { useKeyboard } from "@opentui/react"
import {
    useRef,
    type ReactNode,
} from "react"

import type {
    IAuthenticationService,
    TAuthEvent,
} from "@/auth/contracts"
import type {
    TAuthenticationMode,
    TAuthenticationOutcome,
} from "@/tui/authentication/types"
import { authenticationKeyboardShortcuts } from "@/tui/authentication/keyboard-shortcuts"
import { useAuthenticationFlow } from "@/tui/authentication/use-authentication-flow"
import { theme } from "@/tui/theme"

interface IAuthenticationFlowProps {
    readonly mode: TAuthenticationMode
    readonly authentication: IAuthenticationService
    readonly onClose: (outcome: TAuthenticationOutcome) => void
    readonly openUrl: (url: string) => unknown | Promise<unknown>
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
    const { controller, state } = useAuthenticationFlow(props)
    const promptInputRef = useRef<InputRenderable | null>(null)
    const loginScrollRef = useRef<ScrollBoxRenderable | null>(null)

    useKeyboard((key) => {
        const action = authenticationKeyboardShortcuts.resolve("flow", key)
        if (
            state.type === "login"
            && (action === "scroll.up" || action === "scroll.down")
        ) {
            key.preventDefault()
            key.stopPropagation()
            loginScrollRef.current?.scrollBy(
                action === "scroll.up" ? -1 : 1,
                "viewport",
            )
            return
        }

        const isEmptyProviderList = state.type === "providers"
            && state.providers.length === 0
        const acceptsFlow = action === "accept"
            && (state.type === "success" || isEmptyProviderList)
        if (action !== "cancel" && !acceptsFlow) return

        key.preventDefault()
        key.stopPropagation()
        if (acceptsFlow) {
            controller.close("success")
            return
        }
        controller.cancel()
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
                    {controller.mode === "login" ? "Sign in" : "Sign out"}
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
                                    if (provider) {
                                        controller.selectProvider(provider.providerId)
                                    }
                                }}
                            />
                        ) : (
                            <text fg={theme.textMuted}>
                                No authentication providers are available.
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
                                    if (method) controller.selectMethod(method.id)
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
                                if (index === 0) controller.confirmLogout()
                                else controller.back()
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
                                        key={state.prompt.id}
                                        ref={promptInputRef}
                                        focused
                                        placeholder={state.prompt.placeholder}
                                        textColor={theme.text}
                                        focusedTextColor={theme.text}
                                        placeholderColor={theme.textMuted}
                                        backgroundColor="transparent"
                                        focusedBackgroundColor="transparent"
                                        onSubmit={() => {
                                            controller.submitPrompt(
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
                                if (index === 0) controller.retry()
                                else controller.back()
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
