import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react"

import type { IAuthenticationService } from "@/auth/contracts"
import { AuthenticationFlow } from "@/tui/AuthenticationFlow"
import { Layout } from "@/tui/components/Layout"
import { Home } from "@/tui/components/Home"
import { SessionScreen } from "@/tui/components/Session"
import { buliKeyboardController } from "@/tui/keyboard-controller"
import {
    useBuliUiController,
    useBuliUiSnapshot,
} from "@/tui/ui-controller-state"

interface IBuliTuiProps {
    readonly authentication: IAuthenticationService
}

export function BuliTui(props: IBuliTuiProps) {
    const controller = useBuliUiController()
    const ui = useBuliUiSnapshot()
    const renderer = useRenderer()
    const { width, height } = useTerminalDimensions()

    useKeyboard((key) => {
        const action = buliKeyboardController.resolve("global", key)

        if (action === "cancel") {
            if (ui.authenticationMode) return
            key.preventDefault()
            key.stopPropagation()
            controller.escape()
            return
        }

        if (action === "console.toggle") renderer.console.toggle()
    })

    return (
        <Layout width={width} height={height}>
            {ui.authenticationMode ? (
                <AuthenticationFlow
                    mode={ui.authenticationMode}
                    authentication={props.authentication}
                    onClose={() => controller.closeAuthentication()}
                />
            ) : ui.route.type === "home" ? (
                <Home />
            ) : (
                <SessionScreen
                    key={ui.route.sessionId}
                    sessionId={ui.route.sessionId}
                />
            )}
        </Layout>
    )
}
