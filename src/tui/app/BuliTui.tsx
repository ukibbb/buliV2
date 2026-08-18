import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react"

import type { IAuthenticationService } from "@/auth/contracts"
import { AuthenticationFlow } from "@/tui/authentication/AuthenticationFlow"
import { Layout } from "@/tui/components/Layout"
import { Home } from "@/tui/components/Home"
import { SessionScreen } from "@/tui/components/Session"
import { buliKeyboardShortcuts } from "@/tui/app/keyboard-shortcuts"
import {
    useBuliUiController,
    useBuliUiSnapshot,
} from "@/tui/app/ui-controller-context"

interface IBuliTuiProps {
    readonly authentication: IAuthenticationService
    readonly openUrl: (url: string) => unknown | Promise<unknown>
}

export function BuliTui(props: IBuliTuiProps) {
    const controller = useBuliUiController()
    const ui = useBuliUiSnapshot()
    const renderer = useRenderer()
    const { width, height } = useTerminalDimensions()

    useKeyboard((key) => {
        const action = buliKeyboardShortcuts.resolve("global", key)

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
                    key={ui.authenticationMode}
                    mode={ui.authenticationMode}
                    authentication={props.authentication}
                    onClose={() => controller.closeAuthentication()}
                    openUrl={props.openUrl}
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
