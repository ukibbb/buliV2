import type { InputRenderable } from "@opentui/core"
import {
    useRef,
    type ReactNode,
} from "react"

import type { TAuthEvent } from "@/authentication"
import type {
    AuthenticationFlowController,
    TAuthenticationFlowState,
} from "@/ui/authentication/authentication-flow-controller"
import { theme } from "@/ui/terminal/theme"
import { SecretInput } from "@/ui/authentication/SecretInput"

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

    if (state.type === "login") {
        return (
            <box
                width="100%"
                flexDirection="column"
                gap={1}
            >
                <text fg={theme.green}>{`Login to ${state.provider.name}`}</text>
                {state.event ? <AuthenticationEvent event={state.event} /> : (
                    <text fg={theme.textSecondary}>Starting authentication...</text>
                )}
                {state.browserOpenFailed ? (
                    <text fg={theme.amber}>
                        Could not open the browser automatically. Use the URL above.
                    </text>
                ) : null}
                {state.prompt ? (
                    <box flexDirection="column" gap={1}>
                        <text>{state.prompt.message}</text>
                        <box border={["bottom"]} borderColor={theme.textSecondary}>
                            {state.prompt.presentation === "secret" ? (
                                <SecretInput
                                    key={state.prompt.id}
                                    placeholder={state.prompt.placeholder}
                                    onSubmit={controller.submitPrompt}
                                />
                            ) : <input
                                key={state.prompt.id}
                                ref={promptInputRef}
                                focused
                                selectionOccupancy="boundary"
                                placeholder={state.prompt.placeholder}
                                textColor={theme.text}
                                focusedTextColor={theme.text}
                                placeholderColor={theme.textSecondary}
                                backgroundColor="transparent"
                                focusedBackgroundColor="transparent"
                                onSubmit={() => {
                                    controller.submitPrompt(
                                        promptInputRef.current?.value ?? "",
                                    )
                                }}
                            />}
                        </box>
                        <text fg={theme.textSecondary} selectable={false}>
                            Enter submit · Esc cancel
                        </text>
                    </box>
                ) : (
                    <text fg={theme.textSecondary} selectable={false}>
                        Waiting... · Esc cancel
                    </text>
                )}
                <text fg={theme.textSecondary} selectable={false}>
                    Page Up / Page Down scroll
                </text>
            </box>
        )
    }

    if (state.type === "logout") {
        return (
            <box flexDirection="column" gap={1}>
                <text>{`Disconnecting ${state.provider.name}...`}</text>
                <text fg={theme.textSecondary} selectable={false}>
                    Please wait · Esc cancel
                </text>
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
            <text fg={theme.textSecondary} selectable={false}>
                Enter or Esc close
            </text>
        </box>
    )
}

function AuthenticationEvent(props: { readonly event: TAuthEvent }): ReactNode {
    if (props.event.type === "progress") {
        return <text fg={theme.textSecondary}>{props.event.message}</text>
    }
    if (props.event.type === "authorization") {
        return (
            <box flexDirection="column" gap={1}>
                <text wrapMode="word">
                    <a key={props.event.url} href={props.event.url} fg={theme.green}>
                        {props.event.url}
                    </a>
                </text>
                <text fg={theme.textSecondary} selectable={false}>
                    {process.platform === "darwin" ? "Cmd+click to open" : "Ctrl+click to open"}
                </text>
                <text fg={theme.amber}>{props.event.instructions}</text>
            </box>
        )
    }
    return (
        <box flexDirection="column" gap={1}>
            <text wrapMode="word">
                <a key={props.event.url} href={props.event.url} fg={theme.green}>
                    {props.event.url}
                </a>
            </text>
            <text fg={theme.textSecondary} selectable={false}>
                {process.platform === "darwin" ? "Cmd+click to open" : "Ctrl+click to open"}
            </text>
            <text fg={theme.amber}>{`Enter code: ${props.event.userCode}`}</text>
            <text fg={theme.amber}>{props.event.instructions}</text>
        </box>
    )
}
