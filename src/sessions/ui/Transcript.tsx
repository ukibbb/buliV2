import type { ReactNode } from "react"

import type {
    IAssistantMessage,
    TAgentMessage,
} from "@/agent"
import { ToolCallLine, ToolResultLine } from "@/sessions/ui/ToolActivity"
import { syntax, theme } from "@/terminal/theme"

const MARKDOWN_TABLE_OPTIONS = {
    style: "grid",
    widthMode: "full",
    columnFitter: "proportional",
    wrapMode: "word",
    cellPaddingX: 1,
    borderColor: theme.border,
    selectable: true,
    selectionBg: theme.selectionBg,
    selectionFg: theme.selectionFg,
} as const

export interface ITranscriptProps {
    readonly messages: readonly TAgentMessage[]
    readonly streamingMessage?: IAssistantMessage
    readonly pendingToolCallIds?: readonly string[]
}

function AssistantCard(props: {
    readonly message: IAssistantMessage
    readonly streaming: boolean
    readonly pendingToolCallIds: ReadonlySet<string>
}): ReactNode {
    return (
        <box width="100%" flexDirection="column" paddingLeft={1}>
            {props.message.content.map((content, index) => {
                if (content.type === "text") {
                    return <markdown
                        key={`${props.message.id}-text-${index}`}
                        fg={theme.text}
                        bg={theme.background}
                        content={content.text}
                        syntaxStyle={syntax}
                        streaming={props.streaming}
                        conceal
                        internalBlockMode="top-level"
                        tableOptions={MARKDOWN_TABLE_OPTIONS}
                    />
                }

                if (content.type === "toolCall") {
                    return <ToolCallLine
                        key={content.toolCallId}
                        call={content}
                        running={props.pendingToolCallIds.has(content.toolCallId)}
                    />
                }

                return null
            })}
            {props.message.errorMessage
                ? (
                    <box
                        border={["left"]}
                        borderColor={theme.red}
                        backgroundColor={theme.surface}
                        paddingX={1}
                    >
                        <text
                            fg={theme.red}
                            selectionBg={theme.selectionBg}
                            selectionFg={theme.selectionFg}
                            wrapMode="word"
                        >
                            {props.message.errorMessage}
                        </text>
                    </box>
                )
                : null}
        </box>
    )
}

/** Renders persisted and streaming session messages for the terminal UI. */
export function Transcript(props: ITranscriptProps): ReactNode {
    if (props.messages.length === 0 && !props.streamingMessage) {
        return <text fg={theme.textMuted} padding={1} selectable={false}>
            Start conversation
        </text>
    }

    const pendingToolCallIds = new Set(props.pendingToolCallIds ?? [])
    return (
        <box width="100%" flexDirection="column" paddingX={1}>
            {props.messages.map((message) => {
                switch (message.role) {
                    case "user":
                        return (
                            <box
                                key={message.id}
                                width="100%"
                                flexDirection="column"
                                border={["left"]}
                                borderColor={theme.green}
                                backgroundColor={theme.userBackground}
                                paddingX={2}
                                paddingY={1}
                            >
                                <text
                                    fg={theme.textStrong}
                                    selectionBg={theme.selectionBg}
                                    selectionFg={theme.selectionFg}
                                    wrapMode="word"
                                >
                                    {message.content.trim()}
                                </text>
                            </box>
                        )
                    case "assistant":
                        return <AssistantCard
                            key={message.id}
                            message={message}
                            streaming={false}
                            pendingToolCallIds={pendingToolCallIds}
                        />
                    case "toolResult":
                        return <ToolResultLine key={message.id} message={message} />
                }
            })}
            {props.streamingMessage
                ? <AssistantCard
                    message={props.streamingMessage}
                    streaming
                    pendingToolCallIds={pendingToolCallIds}
                />
                : null}
        </box>
    )
}
