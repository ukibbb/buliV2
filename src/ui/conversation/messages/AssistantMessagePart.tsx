import { memo, type ReactNode } from "react"

import type { IToolCallContent, IToolResultMessage } from "@/agent"
import { MarkdownContent } from "@/ui/conversation/messages/MarkdownContent"
import { ReasoningContent } from "@/ui/conversation/messages/ReasoningContent"
import { ToolCallDisplay } from "@/ui/conversation/tools/ToolCallDisplay"

type TAssistantMessagePartProps = {
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
export const AssistantMessagePart = memo(function AssistantMessagePart(props: TAssistantMessagePartProps): ReactNode {
    switch (props.kind) {
        case "text":
            return <MarkdownContent content={props.text} streaming={props.streaming} />
        case "reasoning":
            return <ReasoningContent text={props.text} streaming={props.streaming} />
        case "tool":
            return <ToolCallDisplay
                call={props.call}
                {...(props.result === undefined ? {} : { result: props.result })}
                {...(props.phase === undefined ? {} : { phase: props.phase })}
            />
    }
})
