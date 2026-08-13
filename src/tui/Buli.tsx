import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react"

import { Layout } from "@/tui/components/Layout"
import { SessionScreen } from "@/tui/components/Session"
import { buliKeyboardController } from "@/tui/keyboard-controller"
import { useBuliUiController } from "@/tui/ui-controller-state"

export function BuliTui() {
    const controller = useBuliUiController()
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
            <SessionScreen sessionId={controller.sessionId} />
        </Layout>
    )
}
