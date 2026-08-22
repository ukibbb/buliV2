import type { SelectOption } from "@opentui/core"
import type { ReactNode } from "react"

import type {
    AuthenticationFlowController,
    TAuthenticationFlowState,
} from "@/authentication/ui/authentication-flow-controller"
import { theme } from "@/terminal/theme"

type TAuthenticationChoiceState = Extract<
    TAuthenticationFlowState,
    { readonly type: "providers" | "methods" | "confirm" | "error" }
>

interface IAuthenticationChoicesProps {
    readonly controller: AuthenticationFlowController
    readonly state: TAuthenticationChoiceState
}

const SELECT_STYLE = {
    focused: true,
    wrapSelection: true,
    showDescription: true,
    backgroundColor: "transparent",
    focusedBackgroundColor: "transparent",
    textColor: theme.text,
    focusedTextColor: theme.text,
    selectedBackgroundColor: theme.green,
    selectedTextColor: theme.text,
    descriptionColor: theme.textMuted,
    selectedDescriptionColor: theme.text,
} as const

const CONFIRM_OPTIONS: SelectOption[] = [
    { name: "Disconnect", description: "Remove the saved connection" },
    { name: "Back", description: "Keep this provider connected" },
]

const RETRY_OPTIONS: SelectOption[] = [
    { name: "Retry", description: "Try the operation again" },
    { name: "Back", description: "Return to the previous step" },
]

/** Renders provider, method, confirmation, and retry selections. */
export function AuthenticationChoices(
    props: IAuthenticationChoicesProps,
): ReactNode {
    const { controller, state } = props

    if (state.type === "providers") {
        const options = state.providers.map((provider): SelectOption => ({
            name: provider.name,
            description: provider.statusError
                ? "Authentication needs repair"
                : provider.connected
                ? `Connected${provider.accountId ? ` as ${provider.accountId}` : ""}`
                : "Not connected",
        }))

        return (
            <box flexDirection="column" gap={1}>
                <text>Select a provider</text>
                {state.providers.length > 0 ? (
                    <select
                        {...SELECT_STYLE}
                        options={options}
                        height={selectHeight(options.length)}
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
        )
    }

    if (state.type === "methods") {
        const options = state.provider.methods.map((method): SelectOption => ({
            name: method.name,
            description: method.description,
        }))

        return (
            <box flexDirection="column" gap={1}>
                <text>{state.provider.name}</text>
                <text>Select a login method</text>
                {state.provider.methods.length > 0 ? (
                    <select
                        {...SELECT_STYLE}
                        options={options}
                        height={selectHeight(options.length)}
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
        )
    }

    if (state.type === "confirm") {
        return (
            <box flexDirection="column" gap={1}>
                <text>{`Disconnect ${state.provider.name}?`}</text>
                <text fg={theme.textMuted}>
                    {`Account: ${state.provider.accountId ?? "unavailable"}`}
                </text>
                <select
                    {...SELECT_STYLE}
                    options={CONFIRM_OPTIONS}
                    height={selectHeight(CONFIRM_OPTIONS.length)}
                    onSelect={(index) => {
                        if (index === 0) controller.confirmLogout()
                        else controller.back()
                    }}
                />
                <text fg={theme.textMuted}>enter select  esc back</text>
            </box>
        )
    }

    return (
        <box flexDirection="column" gap={1}>
            <text fg={theme.red}>{state.message}</text>
            <select
                {...SELECT_STYLE}
                options={RETRY_OPTIONS}
                height={selectHeight(RETRY_OPTIONS.length)}
                onSelect={(index) => {
                    if (index === 0) controller.retry()
                    else controller.back()
                }}
            />
            <text fg={theme.textMuted}>enter select  esc back</text>
        </box>
    )
}

function selectHeight(optionCount: number): number {
    return Math.max(3, Math.min(optionCount * 2, 10))
}
