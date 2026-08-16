import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react"

import { Layout } from "@/tui/components/Layout"
import { Home } from "@/tui/components/Home"
import { SessionScreen } from "@/tui/components/Session"
import { buliKeyboardController } from "@/tui/keyboard-controller"
import {
    useBuliUiController,
    useBuliUiSnapshot,
} from "@/tui/ui-controller-state"

export function BuliTui() {
    const controller = useBuliUiController()
    const ui = useBuliUiSnapshot()
    const renderer = useRenderer()
    const { width, height } = useTerminalDimensions()

    useKeyboard((key) => {
        const action = buliKeyboardController.resolve("global", key)

        if (action === "cancel") {
            key.preventDefault()
            key.stopPropagation()
            controller.escape()
            return
        }

        if (action === "console.toggle") renderer.console.toggle()
    })

    return (
        <Layout width={width} height={height}>
            {ui.route.type === "home" ? (
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
