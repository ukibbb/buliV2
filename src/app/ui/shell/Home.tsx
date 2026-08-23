import type { ReactNode } from "react"

import { Chat } from "@/app/ui/chat/Chat"
import { theme } from "@/terminal/theme"

const BULI_LOGO = [
    " ____        _ _ ",
    "| __ ) _   _| (_)",
    "|  _ \\| | | | | |",
    "| |_) | |_| | | |",
    "|____/ \\__,_|_|_|",
].join("\n")

/** Renders the new-conversation landing view and shared prompt input. */
export function Home(): ReactNode {
    return (
        <box
            width="100%"
            minHeight={0}
            flexGrow={1}
            flexDirection="column"
        >
            <box
                width="100%"
                minHeight={0}
                flexGrow={1}
                alignItems="center"
                justifyContent="center"
            >
                <text fg={theme.green}>{BULI_LOGO}</text>
            </box>
            <Chat />
        </box>
    )
}
