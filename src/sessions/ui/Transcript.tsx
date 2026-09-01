import {
    createMarkdownCodeBlockRenderer,
    DiffRenderable,
} from "@opentui/core"
import { useRenderer } from "@opentui/react"
import { useMemo, type ReactNode } from "react"

import type {
    TAgentMessage,
    IAssistantMessage,
    IFileChangeProposal,
    IFileChangeProposalRecord,
    IToolCallContent,
    IToolResultMessage,
} from "@/agent"
import type { ICompactionCheckpoint } from "@/sessions/compaction/checkpoint"
import { normalizeMarkdownDiff } from "@/sessions/ui/markdown-diff"
import { ProposedChanges } from "@/sessions/ui/ProposedChanges"
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

function isClosedFencedBlock(raw: string): boolean {
    const lastLine = raw.trimEnd().split("\n").at(-1) ?? ""
    return /^ {0,3}(`{3,}|~{3,})[ \t]*$/.test(lastLine)
}

export interface ITranscriptProps {
    readonly messages: readonly TAgentMessage[]
    readonly fileChangeProposals?: readonly IFileChangeProposalRecord[]
    readonly streamingMessage?: IAssistantMessage
    readonly compactionCheckpoint?: ICompactionCheckpoint
    readonly activeRunId?: string
    readonly pendingToolCallIds?: readonly string[]
    readonly pendingFileChangeProposal?: IFileChangeProposal
}

function MarkdownBody(props: {
    readonly content: string
    readonly streaming: boolean
}): ReactNode {
    const renderer = useRenderer()
    const renderNode = useMemo(
        () => createMarkdownCodeBlockRenderer({
            diff: (token, context) => {
                if (props.streaming && !isClosedFencedBlock(token.raw)) {
                    return context.defaultRender()
                }

                const diff = normalizeMarkdownDiff(token.text)
                if (!diff) return context.defaultRender()

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
    readonly checkpoint: ICompactionCheckpoint
}): ReactNode {
    return <box width="100%" flexDirection="column">
        <text fg={theme.textMuted}>Context compacted</text>
        <MarkdownBody content={props.checkpoint.summary} streaming={false} />
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
    const durableHistory = useMemo(
        () => projectTranscriptItems(
            props.messages,
            props.fileChangeProposals ?? [],
        ).map((item) => item.type === "message"
            ? renderDurableMessage(
                item.message,
                projection,
                runningToolCallIds,
            )
            : <ProposedChanges
                key={item.proposal.id}
                proposal={item.proposal}
            />),
        [
            props.messages,
            props.fileChangeProposals,
            projection,
            runningToolCallIds,
        ],
    )
    const checkpointHistory = useMemo(() => {
        if (!props.compactionCheckpoint) return durableHistory

        const checkpointCard = <CompactionCheckpointCard
            key={props.compactionCheckpoint.id}
            checkpoint={props.compactionCheckpoint}
        />
        const anchorIndex = projectTranscriptItems(
            props.messages,
            props.fileChangeProposals ?? [],
        ).findIndex((item) => item.type === "message"
            && item.message.id === props.compactionCheckpoint?.throughMessageId)
        if (anchorIndex < 0) return [...durableHistory, checkpointCard]

        return [
            ...durableHistory.slice(0, anchorIndex + 1),
            checkpointCard,
            ...durableHistory.slice(anchorIndex + 1),
        ]
    }, [
        durableHistory,
        props.messages,
        props.fileChangeProposals,
        props.compactionCheckpoint,
    ])
    const durableProposalIds = new Set(
        (props.fileChangeProposals ?? []).map((proposal) => proposal.id),
    )
    const liveProposal = props.pendingFileChangeProposal === undefined
        || durableProposalIds.has(props.pendingFileChangeProposal.id)
        ? undefined
        : props.pendingFileChangeProposal

    if (
        props.messages.length === 0
        && (props.fileChangeProposals?.length ?? 0) === 0
        && !props.streamingMessage
        && !props.compactionCheckpoint
        && !liveProposal
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
            {liveProposal === undefined
                ? null
                : <ProposedChanges proposal={liveProposal} />}
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
