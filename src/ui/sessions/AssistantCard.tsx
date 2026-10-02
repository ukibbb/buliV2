import { memo, type ReactNode } from "react"

import type { IToolCallContent, IToolResultMessage } from "@/agent"
import { MarkdownBody } from "@/ui/sessions/MarkdownBody"
import { ReasoningBlock } from "@/ui/sessions/ReasoningBlock"
import { ToolCallDisplay } from "@/ui/sessions/ToolCallDisplay"

type TAssistantCardProps = {
    readonly kind: "text" | "reasoning"
    readonly text: string
    readonly streaming: boolean
} | {
    readonly kind: "tool"
    readonly call: IToolCallContent
    readonly result: IToolResultMessage | undefined
    readonly phase: "running" | "pending" | undefined
}

/** Renders one fragment without subscribing it to the rest of its message or tool batch. */
export const AssistantCard = memo(function AssistantCard(props: TAssistantCardProps): ReactNode {
    switch (props.kind) {
        case "text":
            return <MarkdownBody content={props.text} streaming={props.streaming} />
        case "reasoning":
            return <ReasoningBlock text={props.text} streaming={props.streaming} />
        case "tool":
            return <ToolCallDisplay
                call={props.call}
                {...(props.result === undefined ? {} : { result: props.result })}
                {...(props.phase === undefined ? {} : { phase: props.phase })}
            />
    }
})
