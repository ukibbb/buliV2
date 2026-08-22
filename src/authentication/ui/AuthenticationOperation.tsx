import type {
    InputRenderable,
} from "@opentui/core"
import {
    useRef,
    type ReactNode,
} from "react"

import type { TAuthEvent } from "@/authentication/contracts"
import type {
    AuthenticationFlowController,
    TAuthenticationFlowState,
} from "@/authentication/ui/authentication-flow-controller"
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

    if (state.type === "login") {
        return (
            <box
                width="100%"
                flexDirection="column"
                gap={1}
                backgroundColor={theme.surface}
            >
                <text
                    fg={theme.textStrong}
                    selectionBg={theme.selectionBg}
                    selectionFg={theme.selectionFg}
                >{`Signing in to ${state.provider.name}...`}</text>
                {state.event ? <AuthenticationEvent event={state.event} /> : (
                    <text
                        fg={theme.textMuted}
                        selectionBg={theme.selectionBg}
                        selectionFg={theme.selectionFg}
                    >Starting authentication...</text>
                )}
                {state.browserOpenFailed ? (
                    <text
                        fg={theme.amber}
                        selectionBg={theme.selectionBg}
                        selectionFg={theme.selectionFg}
                    >
                        Could not open the browser automatically. Use the URL above.
                    </text>
                ) : null}
                {state.prompt ? (
                    <box flexDirection="column" gap={1}>
                        <text
                            fg={theme.text}
                            selectionBg={theme.selectionBg}
                            selectionFg={theme.selectionFg}
                        >{state.prompt.message}</text>
                        <box border={["bottom"]} borderColor={theme.green}>
                            <input
                                key={state.prompt.id}
                                ref={promptInputRef}
                                focused
                                placeholder={state.prompt.placeholder}
                                textColor={theme.text}
                                focusedTextColor={theme.text}
                                placeholderColor={theme.textMuted}
                                backgroundColor={theme.surface}
                                focusedBackgroundColor={theme.surface}
                                cursorColor={theme.green}
                                cursorStyle={{ style: "line", blinking: true }}
                                selectionBg={theme.selectionBg}
                                selectionFg={theme.selectionFg}
                                onSubmit={() => {
                                    controller.submitPrompt(
                                        promptInputRef.current?.value ?? "",
                                    )
                                }}
                            />
                        </box>
                        <text fg={theme.textMuted} selectable={false}>
                            enter submit  esc cancel
                        </text>
                    </box>
                ) : (
                    <text fg={theme.textMuted} selectable={false}>
                        Waiting...  esc cancel
                    </text>
                )}
                <text fg={theme.textMuted} selectable={false}>
                    page up/down scroll
                </text>
            </box>
        )
    }

    if (state.type === "logout") {
        return (
            <box flexDirection="column" gap={1}>
                <text
                    fg={theme.textStrong}
                    selectionBg={theme.selectionBg}
                    selectionFg={theme.selectionFg}
                >{`Disconnecting ${state.provider.name}...`}</text>
                <text fg={theme.textMuted} selectable={false}>
                    Please wait  esc cancel
                </text>
            </box>
        )
    }

    return (
        <box flexDirection="column" gap={1}>
            <text
                fg={theme.green}
                selectionBg={theme.selectionBg}
                selectionFg={theme.selectionFg}
            ><strong>
                {state.mode === "login"
                    ? "Sign-in complete"
                    : "Sign-out complete"}
            </strong></text>
            <text
                fg={theme.text}
                selectionBg={theme.selectionBg}
                selectionFg={theme.selectionFg}
            >{`Provider: ${state.providerName}`}</text>
            <text
                fg={theme.text}
                selectionBg={theme.selectionBg}
                selectionFg={theme.selectionFg}
            >{`Account: ${state.accountId ?? "unavailable"}`}</text>
            <text fg={theme.textMuted} selectable={false}>
                enter or esc close
            </text>
        </box>
    )
}

function AuthenticationEvent(props: { readonly event: TAuthEvent }): ReactNode {
    if (props.event.type === "progress") {
        return <text
            fg={theme.textMuted}
            selectionBg={theme.selectionBg}
            selectionFg={theme.selectionFg}
        >{props.event.message}</text>
    }
    if (props.event.type === "authorization") {
        return (
            <box flexDirection="column" gap={1}>
                <text
                    fg={theme.text}
                    selectionBg={theme.selectionBg}
                    selectionFg={theme.selectionFg}
                >{props.event.instructions}</text>
                <text
                    selectionBg={theme.selectionBg}
                    selectionFg={theme.selectionFg}
                    wrapMode="word"
                >
                    <a key={props.event.url} href={props.event.url} fg={theme.blue}>
                        {props.event.url}
                    </a>
                </text>
            </box>
        )
    }
    return (
        <box flexDirection="column" gap={1}>
            <text
                fg={theme.text}
                selectionBg={theme.selectionBg}
                selectionFg={theme.selectionFg}
            >{props.event.instructions}</text>
            <text
                selectionBg={theme.selectionBg}
                selectionFg={theme.selectionFg}
                wrapMode="word"
            >
                <a key={props.event.url} href={props.event.url} fg={theme.blue}>
                    {props.event.url}
                </a>
            </text>
            <text
                fg={theme.textStrong}
                selectionBg={theme.selectionBg}
                selectionFg={theme.selectionFg}
            >{`Device code: ${props.event.userCode}`}</text>
        </box>
    )
}
