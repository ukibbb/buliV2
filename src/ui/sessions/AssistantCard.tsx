import type { ReactNode } from "react"

import type { IAssistantMessage, IToolResultMessage } from "@/agent"
import { ErrorNotice } from "@/ui/chat/ErrorNotice"
import { MarkdownBody } from "@/ui/sessions/MarkdownBody"
import { ReasoningBlock } from "@/ui/sessions/ReasoningBlock"
import { ToolCallDisplay } from "@/ui/sessions/ToolCallDisplay"

interface IAssistantCardProps {
    readonly message: IAssistantMessage
    readonly streaming: boolean
    readonly toolResults: ReadonlyMap<string, IToolResultMessage>
    readonly activeToolCallIds: ReadonlySet<string>
    readonly runningToolCallIds: ReadonlySet<string>
}

/** Renders assistant content in provider order, followed by any message error. */
export function AssistantCard(props: IAssistantCardProps): ReactNode {
    return <box width="100%" flexDirection="column">
        {props.message.content.map((content, index) => {
            const key = `${props.message.id}-${content.type}-${index}`
            switch (content.type) {
                case "text":
                    return <MarkdownBody key={key} content={content.text} streaming={props.streaming} />
                case "reasoning":
                    return <ReasoningBlock key={key} text={content.text} streaming={props.streaming} />
                case "toolCall": {
                    const result = props.toolResults.get(content.toolCallId)
                    const phase = toolCallPhase(content.toolCallId, props)
                    return <ToolCallDisplay
                        key={content.toolCallId}
                        call={content}
                        {...(result === undefined ? {} : { result })}
                        {...(phase === undefined ? {} : { phase })}
                    />
                }
                default:
                    return null
            }
        })}
        {props.message.errorMessage ? <ErrorNotice message={props.message.errorMessage} /> : null}
    </box>
}

function toolCallPhase(
    toolCallId: string,
    props: Pick<IAssistantCardProps, "activeToolCallIds" | "runningToolCallIds">,
): "running" | "pending" | undefined {
    if (!props.activeToolCallIds.has(toolCallId)) return undefined
    return props.runningToolCallIds.has(toolCallId) ? "running" : "pending"
}
