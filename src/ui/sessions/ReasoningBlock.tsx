import type { ReactNode } from "react"

import { theme } from "@/ui/terminal/theme"

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
    >
        <text fg={theme.textSecondary} wrapMode="word" truncate={false}>
            <span fg={props.streaming ? theme.amber : theme.violet}>{label}</span>
            {hasText ? props.text : null}
        </text>
    </box>
}
