import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react"

import {
    useBuliRuntime,
} from "@/ui/context/application-context"
import {
    useBuliUiController,
    useBuliNavigationSnapshot,
} from "@/ui/context/ui-controller-context"
import { buliKeyboardShortcuts } from "@/ui/keyboard-shortcuts"
import { Home } from "@/ui/shell/Home"
import { SessionCompletionNotifier } from "@/ui/shell/SessionCompletionNotifier"
import { SessionScreen } from "@/ui/shell/SessionScreen"
import type { IAuthenticationService } from "@/authentication"
import { AuthenticationFlow } from "@/ui/authentication"
import { TerminalViewport } from "@/ui/terminal"

interface IBuliTuiProps {
    readonly authentication: IAuthenticationService
    readonly openUrl: (url: string) => unknown | Promise<unknown>
    readonly now?: () => number
}

/** Renders and routes the connected application terminal interface. */
export function BuliTui(props: IBuliTuiProps) {
    const controller = useBuliUiController()
    const runtime = useBuliRuntime()
    const ui = useBuliNavigationSnapshot()
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
            {ui.route.type === "session" ? (
                <SessionCompletionNotifier
                    key={`completion:${ui.route.sessionId}`}
                    sessionId={ui.route.sessionId}
                    {...(props.now ? { now: props.now } : {})}
                />
            ) : null}
            {ui.authenticationMode ? (
                <AuthenticationFlow
                    key={ui.authenticationMode}
                    mode={ui.authenticationMode}
                    authentication={props.authentication}
                    onClose={(outcome) => {
                        controller.closeAuthentication()
                        if (outcome === "success") {
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
