import type {
    InputRenderable,
    ScrollBoxRenderable,
} from "@opentui/core"
import { useKeyboard } from "@opentui/react"
import {
    useRef,
    type ReactNode,
} from "react"

import type { TAuthEvent } from "@/authentication/contracts"
import type {
    AuthenticationFlowController,
    TAuthenticationFlowState,
} from "@/authentication/ui/authentication-flow-controller"
import { authenticationKeyboardShortcuts } from "@/authentication/ui/keyboard-shortcuts"
import { theme } from "@/terminal/theme"

type TAuthenticationOperationState = Extract<
    TAuthenticationFlowState,
    { readonly type: "login" | "logout" | "success" }
>

interface IAuthenticationOperationProps {
    readonly controller: AuthenticationFlowController
    readonly state: TAuthenticationOperationState
}

/** Renders active authentication work and owns login input and scrolling. */
export function AuthenticationOperation(
    props: IAuthenticationOperationProps,
): ReactNode {
    const { controller, state } = props
    const promptInputRef = useRef<InputRenderable | null>(null)
    const loginScrollRef = useRef<ScrollBoxRenderable | null>(null)

    useKeyboard((key) => {
        const action = authenticationKeyboardShortcuts.resolve("flow", key)
        if (
            state.type !== "login"
            || (action !== "scroll.up" && action !== "scroll.down")
        ) return

        key.preventDefault()
        key.stopPropagation()
        loginScrollRef.current?.scrollBy(
            action === "scroll.up" ? -1 : 1,
            "viewport",
        )
    })

    if (state.type === "login") {
        return (
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
        )
    }

    if (state.type === "logout") {
        return (
            <box flexDirection="column" gap={1}>
                <text>{`Disconnecting ${state.provider.name}...`}</text>
                <text fg={theme.textMuted}>Please wait  esc cancel</text>
            </box>
        )
    }

    return (
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
