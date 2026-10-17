import { useMemo, type ReactNode } from "react"
import type { TAgentMessage, IAssistantMessage } from "@/agent"
import type { ICompactionCheckpoint, ICompactionProgress } from "@/sessions"
import { EMPTY_TOOL_CALL_IDS, projectToolActivities } from "@/ui/conversation/tools/tool-call-matching"
import { buildHistoryBlocks, assistantBlocks, assembleBlocks, type ITranscriptBlock, type VisualKind } from "@/ui/conversation/history/conversation-blocks"
import { ContextCompactionSummary } from "@/ui/conversation/history/ContextCompactionSummary"
import { theme } from "@/ui/terminal/theme"
import { agentAccentColor } from "@/ui/terminal/agent-accent-color"

export interface IConversationMessagesProps {
    readonly agentId?: string | undefined
    readonly messages: readonly TAgentMessage[]
    readonly streamingMessage?: IAssistantMessage
    readonly compactionCheckpoint?: ICompactionCheckpoint
    readonly compactionProgress?: ICompactionProgress
    readonly activeRunId?: string
    readonly pendingToolCallIds?: readonly string[]
    readonly currentErrorMessageId?: string
    readonly checkpointOutsidePage?: boolean
}

const TRANSCRIPT_GROUP_GAP = 1

/** Renders visible fragments in provider order, with one shared spacing policy. */
export function ConversationMessages(props: IConversationMessagesProps): ReactNode {
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
    const accentColor = agentAccentColor(props.agentId)
    const history = useMemo(
        () => buildHistoryBlocks(props.messages, projection, runningToolCallIds, props.currentErrorMessageId, accentColor),
        [props.messages, projection, runningToolCallIds, props.currentErrorMessageId, accentColor],
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
            node: <ContextCompactionSummary summary={visibleCheckpoint.summary} streaming={checkpointStreaming} />,
        } : undefined,
        [visibleCheckpoint, checkpointStreaming],
    )
    const blocks = useMemo(
        () => assembleBlocks(history, liveBlocks, checkpoint, visibleCheckpoint?.throughMessageId, props.checkpointOutsidePage),
        [history, liveBlocks, checkpoint, visibleCheckpoint?.throughMessageId, props.checkpointOutsidePage],
    )

    if (blocks.length === 0) {
        return <text fg={theme.textSecondary} selectable={false}>BULI</text>
    }

    // Direct scrollbox children preserve viewport culling, even for long activity groups.
    return <>{blocks.map((block, index) => <box
        key={block.key}
        width="100%"
        flexShrink={0}
        flexDirection="column"
        paddingTop={gapBefore(blocks[index - 1]?.kind, block.kind)}
        paddingBottom={index === blocks.length - 1 && (isCompact(block.kind) || block.kind === "user" || block.kind === "explorers") ? TRANSCRIPT_GROUP_GAP : 0}
    >{block.node}</box>)}</>
}

function isCompact(kind: VisualKind): boolean {
    return kind === "tool" || kind === "file-tool" || kind === "reasoning"
}

function gapBefore(previous: VisualKind | undefined, current: VisualKind): number {
    if (previous === undefined) return isCompact(current) || current === "user" || current === "explorers" ? TRANSCRIPT_GROUP_GAP : 0
    return previous === "tool" && current === "tool" ? 0 : TRANSCRIPT_GROUP_GAP
}
