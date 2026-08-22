import { useTerminalDimensions } from "@opentui/react"
import type { ReactNode } from "react"

import { Chat } from "@/app/ui/chat/Chat"
import { useBuliUiSnapshot } from "@/app/ui/context/ui-controller-context"
import { theme } from "@/terminal/theme"

/** Renders the new-conversation landing view and shared prompt input. */
export function Home(): ReactNode {
    const { width, height } = useTerminalDimensions()
    const ui = useBuliUiSnapshot()
    const logoFont = width >= 60 && height >= 22
        ? "huge"
        : width >= 36 && height >= 15
            ? "block"
            : "tiny"

    return (
        <box
            width="100%"
            minHeight={0}
            flexGrow={1}
            flexDirection="column"
            backgroundColor={theme.background}
        >
            <box
                width="100%"
                minHeight={0}
                flexGrow={1}
                alignItems="center"
                justifyContent="center"
                overflow="hidden"
            >
                {ui.menu === null ? (
                    <ascii-font
                        text="BULI"
                        font={logoFont}
                        color={theme.green}
                        backgroundColor={theme.background}
                        selectionBg={theme.selectionBg}
                        selectionFg={theme.selectionFg}
                        selectable
                    />
                ) : null}
            </box>
            <Chat />
        </box>
    )
}
