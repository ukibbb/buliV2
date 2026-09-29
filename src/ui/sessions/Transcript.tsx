import {
    createMarkdownCodeBlockRenderer,
    DiffRenderable,
    TextRenderable,
} from "@opentui/core"
import { ErrorNotice } from "@/ui/chat/ErrorNotice"
import { useRenderer } from "@opentui/react"
import { useMemo, type ReactNode } from "react"

import type {
    TAgentMessage,
    IAssistantMessage,
    IFileChangeProposalRecord,
    IToolCallContent,
    IToolResultMessage,
} from "@/agent"
import type { ICompactionCheckpoint, ICompactionProgress } from "@/sessions"
import { MessageCard } from "@/ui/components/MessageCard"
import { colorDiffText } from "@/ui/sessions/colored-diff"
import { normalizeMarkdownDiff } from "@/ui/sessions/markdown-diff"
import { FileChangeDiff } from "@/ui/sessions/FileChangeDiff"
import { ToolCallDisplay } from "@/ui/sessions/ToolCallDisplay"
import { syntax, theme } from "@/ui/terminal/theme"

const REASONING_BOTTOM_PADDING = 1

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

function isClosedFencedBlock(raw: string): boolean {
    const lastLine = raw.trimEnd().split("\n").at(-1) ?? ""
    return /^ {0,3}(`{3,}|~{3,})[ \t]*$/.test(lastLine)
}

export interface ITranscriptProps {
    readonly messages: readonly TAgentMessage[]
    readonly fileChangeProposals?: readonly IFileChangeProposalRecord[]
    readonly streamingMessage?: IAssistantMessage
    readonly compactionCheckpoint?: ICompactionCheckpoint
    readonly compactionProgress?: ICompactionProgress
    readonly activeRunId?: string
    readonly pendingToolCallIds?: readonly string[]
}

function MarkdownBody(props: {
    readonly content: string
    readonly streaming: boolean
}): ReactNode {
    const renderer = useRenderer()
    const renderNode = useMemo(
        () => createMarkdownCodeBlockRenderer({
            diff: (token, context) => {
                const diff = props.streaming && !isClosedFencedBlock(token.raw)
                    ? undefined
                    : normalizeMarkdownDiff(token.text)
                if (!diff) {
                    return new TextRenderable(renderer, {
                        content: colorDiffText(token.text),
                        width: "100%",
                        wrapMode: "word",
                    })
                }

                return new DiffRenderable(renderer, {
                    diff,
                    width: "100%",
                    view: "unified",
                    fg: theme.text,
                    syntaxStyle: context.syntaxStyle,
                    ...(context.treeSitterClient === undefined
                        ? {}
                        : { treeSitterClient: context.treeSitterClient }),
                    wrapMode: "word",
                    conceal: context.concealCode,
                    showLineNumbers: true,
                })
            },
        }),
        [renderer, props.streaming],
    )

    return <markdown
        fg={theme.text}
        content={props.content}
        syntaxStyle={syntax}
        streaming={props.streaming}
        conceal
        concealCode={false}
        internalBlockMode="top-level"
        {...(renderNode === undefined ? {} : { renderNode })}
        tableOptions={MARKDOWN_TABLE_OPTIONS}
    />
}

function CompactionCheckpointCard(props: {
    readonly summary: string
    readonly streaming: boolean
}): ReactNode {
    return <box width="100%" flexDirection="column">
        <text fg={props.streaming ? theme.amber : theme.textMuted}>
            {props.streaming ? "Compacting context…" : "Context compacted"}
        </text>
        <MarkdownBody content={props.summary} streaming={props.streaming} />
    </box>
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
                    return <MarkdownBody
                        key={`${props.message.id}-text-${index}`}
                        content={content.text}
                        streaming={props.streaming}
                    />
                }

                if (content.type === "reasoning") {
                    const hasSummary = content.text.trim().length > 0
                    if (!hasSummary && !props.streaming) return null

                    return <box
                        key={`${props.message.id}-reasoning-${index}`}
                        width="100%"
                        flexDirection="column"
                        paddingBottom={REASONING_BOTTOM_PADDING}
                    >
                        <text fg={theme.textMuted} wrapMode="word" truncate={false}>
                            <span fg={props.streaming ? theme.amber : theme.pink}>
                                {hasSummary
                                    ? `${props.streaming ? "Thinking" : "Thought"}: `
                                    : "Thinking..."}
                            </span>
                            {hasSummary ? content.text : null}
                        </text>
                    </box>
                }

                if (content.type === "toolCall") {
                    const result = props.toolResults.get(content.toolCallId)
                    const phase = props.activeToolCallIds.has(content.toolCallId)
                        ? props.runningToolCallIds.has(content.toolCallId)
                            ? "running" as const
                            : "pending" as const
                        : undefined
                    return <ToolCallDisplay
                        key={content.toolCallId}
                        call={content}
                        {...(result === undefined ? {} : { result })}
                        {...(phase === undefined ? {} : { phase })}
                    />
                }

                return null
            })}
            {props.message.errorMessage
                ? <ErrorNotice message={props.message.errorMessage} />
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
    const transcriptItems = useMemo(
        () => projectTranscriptItems(props.messages, props.fileChangeProposals ?? []),
        [props.messages, props.fileChangeProposals],
    )
    const durableHistory = useMemo(
        () => transcriptItems.map((item) => item.type === "message"
            ? renderDurableMessage(
                item.message,
                projection,
                runningToolCallIds,
            )
            : <FileChangeDiff
                key={item.proposal.id}
                diff={item.proposal.diff}
                path={item.proposal.path}
            />),
        [transcriptItems, projection, runningToolCallIds],
    )
    const visibleCheckpoint = props.compactionProgress ?? props.compactionCheckpoint
    const checkpointStreaming = props.compactionProgress !== undefined
    const checkpointAnchorId = visibleCheckpoint?.throughMessageId
    const checkpointAnchorIndex = useMemo(
        () => transcriptItems.findIndex((item) => item.type === "message"
            && item.message.id === checkpointAnchorId),
        [transcriptItems, checkpointAnchorId],
    )
    const checkpointHistory = useMemo(() => {
        if (!visibleCheckpoint) return durableHistory

        const checkpointCard = <CompactionCheckpointCard
            key={visibleCheckpoint.id}
            summary={visibleCheckpoint.summary}
            streaming={checkpointStreaming}
        />
        if (checkpointAnchorIndex < 0) return [...durableHistory, checkpointCard]

        return [
            ...durableHistory.slice(0, checkpointAnchorIndex + 1),
            checkpointCard,
            ...durableHistory.slice(checkpointAnchorIndex + 1),
        ]
    }, [durableHistory, visibleCheckpoint, checkpointStreaming, checkpointAnchorIndex])

    if (
        props.messages.length === 0
        && (props.fileChangeProposals?.length ?? 0) === 0
        && !props.streamingMessage
        && !visibleCheckpoint
    ) {
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
        ? checkpointHistory
        : [...checkpointHistory, liveAssistant]
    return (
        <box width="100%" flexDirection="column">
            {renderedMessages}
        </box>
    )
}

type TTranscriptItem =
    | { readonly type: "message"; readonly message: TAgentMessage }
    | {
        readonly type: "fileChangeProposal"
        readonly proposal: IFileChangeProposalRecord
    }

function projectTranscriptItems(
    messages: readonly TAgentMessage[],
    proposals: readonly IFileChangeProposalRecord[],
): readonly TTranscriptItem[] {
    const items: TTranscriptItem[] = messages.map((message) => ({
        type: "message",
        message,
    }))
    for (const proposal of proposals) {
        const matchingAssistantIndex = items.findIndex((item) =>
            item.type === "message"
            && item.message.role === "assistant"
            && item.message.content.some((content) =>
                content.type === "toolCall"
                && content.toolCallId === proposal.toolCallId
            ))
        const laterItemIndex = items.findIndex((item, index) =>
            index > matchingAssistantIndex
            && item.type === "message"
            && item.message.createdAt > proposal.createdAt)
        const insertionIndex = laterItemIndex < 0
            ? items.length
            : laterItemIndex
        items.splice(insertionIndex, 0, {
            type: "fileChangeProposal",
            proposal,
        })
    }
    return items
}

function renderDurableMessage(
    message: TAgentMessage,
    projection: IToolActivityProjection,
    runningToolCallIds: ReadonlySet<string>,
): ReactNode {
    switch (message.role) {
        case "user":
            return <MessageCard
                key={message.id}
                id={`user-message-${message.id}`}
                content={message.content}
                borderColor={theme.green}
                marginY={1}
            />
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
                : <ToolCallDisplay key={message.id} result={message} />
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
