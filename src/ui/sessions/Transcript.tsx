import { useMemo, type ReactNode } from "react"

import type { TAgentMessage, IAssistantMessage, IFileChangeProposalRecord } from "@/agent"
import type { ICompactionCheckpoint, ICompactionProgress } from "@/sessions"
import { MessageCard } from "@/ui/components/MessageCard"
import { AssistantCard } from "@/ui/sessions/AssistantCard"
import { FileChangeDiff } from "@/ui/sessions/FileChangeDiff"
import { MarkdownBody } from "@/ui/sessions/MarkdownBody"
import { ToolCallDisplay } from "@/ui/sessions/ToolCallDisplay"
import {
    EMPTY_TOOL_CALL_IDS,
    EMPTY_TOOL_RESULTS,
    projectToolActivities,
    projectTranscriptItems,
    toolCallIds,
    type IToolActivityProjection,
} from "@/ui/sessions/transcript-projection"
import { theme } from "@/ui/terminal/theme"

export interface ITranscriptProps {
    readonly messages: readonly TAgentMessage[]
    readonly fileChangeProposals?: readonly IFileChangeProposalRecord[]
    readonly streamingMessage?: IAssistantMessage
    readonly compactionCheckpoint?: ICompactionCheckpoint
    readonly compactionProgress?: ICompactionProgress
    readonly activeRunId?: string
    readonly pendingToolCallIds?: readonly string[]
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
            ? renderDurableMessage(item.message, projection, runningToolCallIds)
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
    return <box width="100%" flexDirection="column">
        {renderedMessages}
    </box>
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
