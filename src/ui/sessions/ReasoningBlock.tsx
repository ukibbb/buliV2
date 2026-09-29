import type { ReactNode } from "react"

import { theme } from "@/ui/terminal/theme"

const REASONING_BOTTOM_PADDING = 1

/** Displays provider reasoning as plain text, including the empty streaming state. */
export function ReasoningBlock(props: {
    readonly text: string
    readonly streaming: boolean
}): ReactNode {
    const hasText = props.text.trim().length > 0
    if (!hasText && !props.streaming) return null

    const label = hasText
        ? `${props.streaming ? "Thinking" : "Thought"}: `
        : "Thinking..."

    return <box
        width="100%"
        flexDirection="column"
        paddingBottom={REASONING_BOTTOM_PADDING}
    >
        <text fg={theme.textMuted} wrapMode="word" truncate={false}>
            <span fg={props.streaming ? theme.amber : theme.pink}>{label}</span>
            {hasText ? props.text : null}
        </text>
    </box>
}
