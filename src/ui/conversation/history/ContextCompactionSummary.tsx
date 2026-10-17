import type { ReactNode } from "react"
import { MarkdownContent } from "@/ui/conversation/messages/MarkdownContent"
import { theme } from "@/ui/terminal/theme"

export function ContextCompactionSummary(props: {
    readonly summary: string
    readonly streaming: boolean
}): ReactNode {
    return <box width="100%" flexDirection="column" gap={1}>
        <box
            width="100%"
            border
            borderStyle="single"
            borderColor={props.streaming ? theme.amber : theme.green}
            paddingX={1}
        >
            <text fg={props.streaming ? theme.amber : theme.green}>
                {props.streaming ? "Compacting context…" : "Context compacted"}
            </text>
        </box>
        {props.streaming
            ? <text fg={theme.text} content={props.summary} wrapMode="word" />
            : <MarkdownContent content={props.summary} streaming={false} />}
    </box>
}
