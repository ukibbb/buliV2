import { useMemo, type ReactNode } from "react"

import type { TAgentMessage, IAssistantMessage } from "@/agent"
import type { ICompactionCheckpoint, ICompactionProgress } from "@/sessions"
import { MessageCard } from "@/ui/components/MessageCard"
import { ErrorNotice } from "@/ui/chat/ErrorNotice"
import { AssistantCard } from "@/ui/sessions/AssistantCard"
import { MarkdownBody } from "@/ui/sessions/MarkdownBody"
import { ToolCallDisplay, isVisibleTool } from "@/ui/sessions/ToolCallDisplay"
import {
    EMPTY_TOOL_CALL_IDS,
    EMPTY_TOOL_RESULTS,
    projectToolActivities,
    type IToolActivityProjection,
} from "@/ui/sessions/transcript-projection"
import { theme } from "@/ui/terminal/theme"

export interface ITranscriptProps {
    readonly messages: readonly TAgentMessage[]
    readonly streamingMessage?: IAssistantMessage
    readonly compactionCheckpoint?: ICompactionCheckpoint
    readonly compactionProgress?: ICompactionProgress
    readonly activeRunId?: string
    readonly pendingToolCallIds?: readonly string[]
    readonly currentErrorMessageId?: string
    readonly checkpointOutsidePage?: boolean
}

type VisualKind = "tool" | "reasoning" | "text" | "user" | "diff" | "error" | "checkpoint"
interface ITranscriptBlock {
    readonly key: string
    readonly kind: VisualKind
    readonly node: ReactNode
}
interface IHistoryBlocks {
    readonly blocks: readonly ITranscriptBlock[]
    readonly positionsAfterMessage: ReadonlyMap<string, number>
}
const TRANSCRIPT_GROUP_GAP = 1

/** Renders visible fragments in provider order, with one shared spacing policy. */
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
    const history = useMemo(
        () => buildHistoryBlocks(props.messages, projection, runningToolCallIds, props.currentErrorMessageId),
        [props.messages, projection, runningToolCallIds, props.currentErrorMessageId],
    )
    const liveBlocks = useMemo(
        () => props.streamingMessage
            ? assistantBlocks(props.streamingMessage, true, projection, runningToolCallIds, props.currentErrorMessageId)
            : [],
        [props.streamingMessage, projection, runningToolCallIds, props.currentErrorMessageId],
    )
    const visibleCheckpoint = props.compactionProgress ?? props.compactionCheckpoint
    const checkpointStreaming = props.compactionProgress !== undefined
    const checkpoint = useMemo<ITranscriptBlock | undefined>(
        () => visibleCheckpoint ? {
            key: `checkpoint-${visibleCheckpoint.id}`,
            kind: "checkpoint",
            node: <CompactionCheckpointCard summary={visibleCheckpoint.summary} streaming={checkpointStreaming} />,
        } : undefined,
        [visibleCheckpoint, checkpointStreaming],
    )
    const blocks = useMemo(
        () => assembleBlocks(history, liveBlocks, checkpoint, visibleCheckpoint?.throughMessageId, props.checkpointOutsidePage),
        [history, liveBlocks, checkpoint, visibleCheckpoint?.throughMessageId, props.checkpointOutsidePage],
    )

    if (blocks.length === 0) {
        return <text fg={theme.textSecondary} selectable={false}>Start conversation</text>
    }

    // Direct scrollbox children preserve viewport culling, even for long activity groups.
    return <>{blocks.map((block, index) => <box
        key={block.key}
        width="100%"
        flexShrink={0}
        flexDirection="column"
        paddingTop={gapBefore(blocks[index - 1]?.kind, block.kind)}
        paddingBottom={index === blocks.length - 1 && (isCompact(block.kind) || block.kind === "user") ? TRANSCRIPT_GROUP_GAP : 0}
    >{block.node}</box>)}</>
}

function isCompact(kind: VisualKind): boolean {
    return kind === "tool" || kind === "reasoning"
}

function gapBefore(previous: VisualKind | undefined, current: VisualKind): number {
    if (previous === undefined) return isCompact(current) || current === "user" ? TRANSCRIPT_GROUP_GAP : 0
    return previous === current && isCompact(current) ? 0 : TRANSCRIPT_GROUP_GAP
}

function buildHistoryBlocks(
    messages: readonly TAgentMessage[],
    projection: IToolActivityProjection,
    runningToolCallIds: ReadonlySet<string>,
    currentErrorMessageId: string | undefined,
): IHistoryBlocks {
    const blocks: ITranscriptBlock[] = []
    const positionsAfterMessage = new Map<string, number>()
    for (const message of messages) {
        blocks.push(...messageBlocks(message, projection, runningToolCallIds, currentErrorMessageId))
        // Invisible messages still provide valid checkpoint boundaries.
        positionsAfterMessage.set(message.id, blocks.length)
    }
    return { blocks, positionsAfterMessage }
}

/** Combines cached elements without moving live fragments beneath a different React parent. */
function assembleBlocks(
    history: IHistoryBlocks,
    liveBlocks: readonly ITranscriptBlock[],
    checkpoint: ITranscriptBlock | undefined,
    throughMessageId: string | undefined,
    checkpointOutsidePage: boolean | undefined,
): readonly ITranscriptBlock[] {
    const blocks = [...history.blocks]
    if (checkpoint) {
        const position = throughMessageId === undefined ? undefined : history.positionsAfterMessage.get(throughMessageId)
        if (position !== undefined) {
            blocks.splice(position, 0, checkpoint)
        } else if (checkpointOutsidePage) {
            blocks.unshift({ ...checkpoint, node: <>
                <text fg={theme.textSecondary}>Podsumowanie wcześniejszej historii — jego granica jest poza tą stroną.</text>
                {checkpoint.node}
            </> })
        }
    }
    return [...blocks, ...liveBlocks]
}

function messageBlocks(
    message: TAgentMessage,
    projection: IToolActivityProjection,
    runningToolCallIds: ReadonlySet<string>,
    currentErrorMessageId: string | undefined,
): ITranscriptBlock[] {
    switch (message.role) {
        case "user":
            return [{
                key: message.id,
                kind: "user",
                node: <MessageCard id={`user-message-${message.id}`} content={message.content} borderColor={theme.green} />,
            }]
        case "assistant":
            return assistantBlocks(message, false, projection, runningToolCallIds, currentErrorMessageId)
        case "toolResult":
            return projection.matchedToolResultMessageIds.has(message.id) || !isVisibleTool(message.toolName)
                ? []
                : [{ key: message.id, kind: "tool", node: <ToolCallDisplay result={message} /> }]
    }
}

function assistantBlocks(
    message: IAssistantMessage,
    streaming: boolean,
    projection: IToolActivityProjection,
    runningToolCallIds: ReadonlySet<string>,
    currentErrorMessageId: string | undefined,
): ITranscriptBlock[] {
    const blocks: ITranscriptBlock[] = []
    const activeToolCallIds = projection.activeAssistantMessageId === message.id
        ? projection.activeToolCallIds : EMPTY_TOOL_CALL_IDS
    const toolResults = streaming ? EMPTY_TOOL_RESULTS
        : projection.resultsByAssistantMessageId.get(message.id) ?? EMPTY_TOOL_RESULTS
    for (const [index, content] of message.content.entries()) {
        let kind: VisualKind
        let node: ReactNode
        switch (content.type) {
            case "text":
                if (!content.text.trim()) continue
                kind = "text"
                node = <AssistantCard kind="text" text={content.text} streaming={streaming} />
                break
            case "reasoning":
                if (!streaming && !content.text.trim()) continue
                kind = "reasoning"
                node = <AssistantCard kind="reasoning" text={content.text} streaming={streaming} />
                break
            case "toolCall": {
                if (!isVisibleTool(content.toolName)) continue
                kind = "tool"
                const active = streaming || activeToolCallIds.has(content.toolCallId)
                const phase = active ? runningToolCallIds.has(content.toolCallId) ? "running" : "pending" : undefined
                node = <AssistantCard kind="tool" call={content} result={toolResults.get(content.toolCallId)} phase={phase} />
                break
            }
            default:
                continue
        }
        blocks.push({ key: `${message.id}-${content.type}-${index}`, kind, node })
    }
    if (message.errorMessage && message.id !== currentErrorMessageId) {
        blocks.push({
            key: `${message.id}-error`, kind: "error",
            node: <ErrorNotice id={`message-error-${message.id}`} message={message.errorMessage} />,
        })
    }
    return blocks
}

function CompactionCheckpointCard(props: {
    readonly summary: string
    readonly streaming: boolean
}): ReactNode {
    return <box width="100%" flexDirection="column" gap={1}>
        <box
            width="100%"
            border={props.streaming}
            borderStyle="single"
            borderColor={theme.amber}
            paddingX={props.streaming ? 1 : 0}
        >
            <text fg={props.streaming ? theme.amber : theme.textSecondary}>
                {props.streaming ? "Compacting context…" : "Context compacted"}
            </text>
        </box>
        {props.streaming
            ? <text fg={theme.text} content={props.summary} wrapMode="word" />
            : <MarkdownBody content={props.summary} streaming={false} />}
    </box>
}
