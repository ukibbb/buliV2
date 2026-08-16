import type { ReactNode } from "react"

import { Chat } from "@/tui/components/Chat"
import { theme } from "@/tui/theme"

const BULI_LOGO = [
    " ____        _ _ ",
    "| __ ) _   _| (_)",
    "|  _ \\| | | | | |",
    "| |_) | |_| | | |",
    "|____/ \\__,_|_|_|",
].join("\n")

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
