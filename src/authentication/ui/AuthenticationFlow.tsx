import { useKeyboard } from "@opentui/react"
import type { ReactNode } from "react"

import type { IAuthenticationService } from "@/authentication/contracts"
import { AuthenticationChoices } from "@/authentication/ui/AuthenticationChoices"
import type {
    AuthenticationFlowController,
    TAuthenticationFlowState,
} from "@/authentication/ui/authentication-flow-controller"
import { AuthenticationOperation } from "@/authentication/ui/AuthenticationOperation"
import type {
    TAuthenticationMode,
    TAuthenticationOutcome,
} from "@/authentication/ui/types"
import { authenticationKeyboardShortcuts } from "@/authentication/ui/keyboard-shortcuts"
import { useAuthenticationFlow } from "@/authentication/ui/use-authentication-flow"
import { theme } from "@/terminal/theme"

interface IAuthenticationFlowProps {
    readonly mode: TAuthenticationMode
    readonly authentication: IAuthenticationService
    readonly onClose: (outcome: TAuthenticationOutcome) => void
    readonly openUrl: (url: string) => unknown | Promise<unknown>
}

/** Renders the complete login/logout workflow while delegating state to its controller. */
export function AuthenticationFlow(
    props: IAuthenticationFlowProps,
): ReactNode {
    const { controller, state } = useAuthenticationFlow(props)

    useKeyboard((key) => {
        const action = authenticationKeyboardShortcuts.resolve("flow", key)
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
                {renderActiveState(controller, state)}
            </box>
        </box>
    )
}

function renderActiveState(
    controller: AuthenticationFlowController,
    state: TAuthenticationFlowState,
): ReactNode {
    switch (state.type) {
        case "loading":
            return <text fg={theme.textMuted}>Loading providers...</text>
        case "providers":
        case "methods":
        case "confirm":
        case "error":
            return <AuthenticationChoices controller={controller} state={state} />
        case "login":
        case "logout":
        case "success":
            return <AuthenticationOperation controller={controller} state={state} />
    }
}
