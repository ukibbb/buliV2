import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react"

import {
    useBuliRuntime,
} from "@/app/ui/context/application-context"
import {
    useBuliUiController,
    useBuliUiSnapshot,
} from "@/app/ui/context/ui-controller-context"
import { buliKeyboardShortcuts } from "@/app/ui/keyboard-shortcuts"
import { Home } from "@/app/ui/shell/Home"
import { SessionScreen } from "@/app/ui/shell/SessionScreen"
import type { IAuthenticationService } from "@/authentication"
import { AuthenticationFlow } from "@/authentication/ui"
import { TerminalViewport } from "@/terminal"

interface IBuliTuiProps {
    readonly authentication: IAuthenticationService
    readonly openUrl: (url: string) => unknown | Promise<unknown>
}

/** Renders and routes the connected application terminal interface. */
export function BuliTui(props: IBuliTuiProps) {
    const controller = useBuliUiController()
    const runtime = useBuliRuntime()
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

        if (action === "console.toggle") {
            // Stop the focused editor from also treating Ctrl+D as forward delete.
            key.preventDefault()
            key.stopPropagation()
            renderer.console.toggle()
        }
    })

    return (
        <TerminalViewport width={width} height={height}>
            {ui.authenticationMode ? (
                <AuthenticationFlow
                    key={ui.authenticationMode}
                    mode={ui.authenticationMode}
                    authentication={props.authentication}
                    onClose={(outcome) => {
                        const mode = ui.authenticationMode
                        controller.closeAuthentication()
                        if (mode === "login" && outcome === "success") {
                            void runtime.refreshModels().catch(() => { })
                        }
                    }}
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
        </TerminalViewport>
    )
}
