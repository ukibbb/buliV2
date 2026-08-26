import { useMemo, type ReactNode } from "react"

import type {
    IAssistantMessage,
    IToolCallContent,
    IToolResultMessage,
    TAgentMessage,
} from "@/agent"
import { ToolActivityLine } from "@/sessions/ui/ToolActivity"
import { syntax, theme } from "@/terminal/theme"

const MARKDOWN_TABLE_OPTIONS = {
    style: "grid",
    widthMode: "full",
    columnFitter: "proportional",
    wrapMode: "word",
    cellPaddingX: 1,
    cellPaddingY: 0,
    borders: true,
    outerBorder: true,
    borderStyle: "single",
    borderColor: theme.textMuted,
    selectable: true,
} as const

export interface ITranscriptProps {
    readonly messages: readonly TAgentMessage[]
    readonly streamingMessage?: IAssistantMessage
    readonly activeRunId?: string
    readonly pendingToolCallIds?: readonly string[]
}

function AssistantCard(props: {
    readonly message: IAssistantMessage
    readonly streaming: boolean
    readonly toolResults: ReadonlyMap<string, IToolResultMessage>
    readonly activeToolCallIds: ReadonlySet<string>
    readonly runningToolCallIds: ReadonlySet<string>
}): ReactNode {
    return (
        <box width="100%" flexDirection="column">
            {props.message.content.map((content, index) => {
                if (content.type === "text") {
                    return <markdown
                        key={`${props.message.id}-text-${index}`}
                        fg={theme.text}
                        content={content.text}
                        syntaxStyle={syntax}
                        streaming={props.streaming}
                        conceal
                        concealCode={false}
                        internalBlockMode="top-level"
                        tableOptions={MARKDOWN_TABLE_OPTIONS}
                    />
                }

                if (content.type === "reasoning") {
                    const hasSummary = content.text.trim().length > 0
                    if (!hasSummary && !props.streaming) return null

                    return <text
                        key={`${props.message.id}-reasoning-${index}`}
                        fg={props.streaming ? theme.amber : theme.textMuted}
                        wrapMode="word"
                        truncate={false}
                    >
                        {hasSummary
                            ? `${props.streaming ? "Thinking" : "Thought"}: ${content.text}`
                            : "Thinking..."}
                    </text>
                }

                if (content.type === "toolCall") {
                    const result = props.toolResults.get(content.toolCallId)
                    const phase = props.activeToolCallIds.has(content.toolCallId)
                        ? props.runningToolCallIds.has(content.toolCallId)
                            ? "running" as const
                            : "pending" as const
                        : undefined
                    return <ToolActivityLine
                        key={content.toolCallId}
                        call={content}
                        {...(result === undefined ? {} : { result })}
                        {...(phase === undefined ? {} : { phase })}
                    />
                }

                return null
            })}
            {props.message.errorMessage
                ? <text fg={theme.red}>{props.message.errorMessage}</text>
                : null}
        </box>
    )
}

/** Renders persisted and streaming session messages for the terminal UI. */
export function Transcript(props: ITranscriptProps): ReactNode {
    const projection = useMemo(
        () => projectToolActivities(props.messages, props.activeRunId),
        [props.messages, props.activeRunId],
    )
    const runningToolCallIds = useMemo(
        () => props.pendingToolCallIds === undefined
            ? EMPTY_TOOL_CALL_IDS
            : new Set(props.pendingToolCallIds),
        [props.pendingToolCallIds],
    )
    // Structural sharing keeps durable tool/Markdown presentation intact on live text deltas.
    const durableHistory = useMemo(
        () => props.messages.map((message) => renderDurableMessage(
            message,
            projection,
            runningToolCallIds,
        )),
        [props.messages, projection, runningToolCallIds],
    )

    if (props.messages.length === 0 && !props.streamingMessage) {
        return <text fg={theme.textMuted} selectable={false}>
            Start conversation
        </text>
    }

    const liveAssistant = props.streamingMessage
        ? <AssistantCard
            key={props.streamingMessage.id}
            message={props.streamingMessage}
            streaming
            toolResults={EMPTY_TOOL_RESULTS}
            activeToolCallIds={toolCallIds(props.streamingMessage)}
            runningToolCallIds={runningToolCallIds}
        />
        : null
    const renderedMessages = liveAssistant === null
        ? durableHistory
        : [...durableHistory, liveAssistant]
    return (
        <box width="100%" flexDirection="column">
            {renderedMessages}
        </box>
    )
}

function renderDurableMessage(
    message: TAgentMessage,
    projection: IToolActivityProjection,
    runningToolCallIds: ReadonlySet<string>,
): ReactNode {
    switch (message.role) {
        case "user":
            return <text bg={theme.green} key={message.id} margin={1}>
                {message.content.trim()}
            </text>
        case "assistant":
            return <AssistantCard
                key={message.id}
                message={message}
                streaming={false}
                toolResults={projection.resultsByAssistantMessageId.get(message.id)
                    ?? EMPTY_TOOL_RESULTS}
                activeToolCallIds={projection.activeAssistantMessageId === message.id
                    ? projection.activeToolCallIds
                    : EMPTY_TOOL_CALL_IDS}
                runningToolCallIds={runningToolCallIds}
            />
        case "toolResult":
            return projection.matchedToolResultMessageIds.has(message.id)
                ? null
                : <ToolActivityLine key={message.id} result={message} />
    }
}

const EMPTY_TOOL_RESULTS: ReadonlyMap<string, IToolResultMessage> = new Map()
const EMPTY_TOOL_CALL_IDS: ReadonlySet<string> = new Set()

interface IToolActivityProjection {
    readonly resultsByAssistantMessageId: ReadonlyMap<
        string,
        ReadonlyMap<string, IToolResultMessage>
    >
    readonly matchedToolResultMessageIds: ReadonlySet<string>
    readonly activeAssistantMessageId?: string
    readonly activeToolCallIds: ReadonlySet<string>
}

interface IOpenToolBatch {
    readonly message: IAssistantMessage
    readonly callsById: Map<string, IToolCallContent>
}

function projectToolActivities(
    messages: readonly TAgentMessage[],
    activeRunId: string | undefined,
): IToolActivityProjection {
    const resultsByAssistantMessageId = new Map<
        string,
        Map<string, IToolResultMessage>
    >()
    const matchedToolResultMessageIds = new Set<string>()
    let openBatch: IOpenToolBatch | undefined

    for (const message of messages) {
        if (message.role === "toolResult") {
            if (!openBatch || !belongsToBatch(message, openBatch)) continue
            const call = openBatch.callsById.get(message.toolCallId)
            if (!call || call.toolName !== message.toolName) continue

            let results = resultsByAssistantMessageId.get(openBatch.message.id)
            if (!results) {
                results = new Map()
                resultsByAssistantMessageId.set(openBatch.message.id, results)
            }
            results.set(message.toolCallId, message)
            matchedToolResultMessageIds.add(message.id)
            openBatch.callsById.delete(message.toolCallId)
            continue
        }

        openBatch = undefined
        if (message.role !== "assistant") continue
        if (message.stopReason === "aborted" || message.stopReason === "error") continue
        const calls = message.content.filter(
            (content): content is IToolCallContent => content.type === "toolCall",
        )
        if (calls.length === 0) continue
        openBatch = {
            message,
            callsById: new Map(calls.map((call) => [call.toolCallId, call])),
        }
    }

    const active = openBatch?.message.runId === activeRunId ? openBatch : undefined
    return {
        resultsByAssistantMessageId,
        matchedToolResultMessageIds,
        ...(active === undefined ? {} : { activeAssistantMessageId: active.message.id }),
        activeToolCallIds: active === undefined
            ? EMPTY_TOOL_CALL_IDS
            : new Set(active.callsById.keys()),
    }
}

function belongsToBatch(
    result: IToolResultMessage,
    batch: IOpenToolBatch,
): boolean {
    return result.sessionId === batch.message.sessionId
        && result.runId === batch.message.runId
}

function toolCallIds(message: IAssistantMessage): ReadonlySet<string> {
    return new Set(message.content.flatMap((content) =>
        content.type === "toolCall" ? [content.toolCallId] : []
    ))
}
