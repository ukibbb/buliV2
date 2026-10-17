import type { ReactNode } from "react"

import { MessageComposer } from "@/ui/composer/MessageComposer"
import { theme } from "@/ui/terminal/theme"

const BULI_LOGO = [
    " ____        _ _ ",
    "| __ ) _   _| (_)",
    "|  _ \\| | | | | |",
    "| |_) | |_| | | |",
    "|____/ \\__,_|_|_|",
].join("\n")

/** Renders the new-conversation landing view and shared prompt input. */
export function HomeScreen(): ReactNode {
    return (
        <box
            width="100%"
            minHeight={0}
            flexBasis={0}
            flexGrow={1}
            flexDirection="column"
        >
            <box
                width="100%"
                minHeight={0}
                flexBasis={0}
                flexGrow={1}
                overflow="hidden"
                alignItems="center"
                justifyContent="center"
            >
                <text fg={theme.green}>{BULI_LOGO}</text>
            </box>
            <MessageComposer />
        </box>
    )
}
