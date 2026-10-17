import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react"

import {
    useBuliRuntime,
    useSessionSelector,
} from "@/ui/context/application-context"
import {
    useBuliUiController,
    useBuliNavigationSnapshot,
} from "@/ui/context/ui-controller-context"
import { buliKeyboardShortcuts } from "@/ui/keyboard/application-shortcuts"
import { HomeScreen } from "@/ui/screens/HomeScreen"
import { SessionCompletionNotifier } from "@/ui/notifications/SessionCompletionNotifier"
import { SessionScreen } from "@/ui/screens/SessionScreen"
import type { IAuthenticationService } from "@/authentication"
import { AuthenticationFlow } from "@/ui/authentication"
import { TerminalViewport } from "@/ui/terminal"
import { agentAccentColor } from "@/ui/terminal/agent-accent-color"
import type { ISessionSnapshot } from "@/sessions"

const selectAgentId = (snapshot: ISessionSnapshot) => snapshot.agentId

interface IApplicationScreenProps {
    readonly authentication: IAuthenticationService
    readonly openUrl: (url: string) => unknown | Promise<unknown>
    readonly now?: () => number
}

/** Renders and routes the connected application terminal interface. */
export function ApplicationScreen(props: IApplicationScreenProps) {
    const controller = useBuliUiController()
    const runtime = useBuliRuntime()
    const ui = useBuliNavigationSnapshot()
    const agentId = useSessionSelector(ui.route.type === "session" ? ui.route.sessionId : undefined, selectAgentId)
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
            {!ui.authenticationMode ? (
                <text
                    id="workspace-header"
                    fg={agentAccentColor(agentId)}
                    width="100%"
                    height={1}
                    flexShrink={0}
                    wrapMode="none"
                    truncate
                >{controller.workspaceRoot}</text>
            ) : null}
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
                <HomeScreen />
            ) : (
                <SessionScreen
                    key={ui.route.sessionId}
                    sessionId={ui.route.sessionId}
                />
            )}
        </TerminalViewport>
    )
}
