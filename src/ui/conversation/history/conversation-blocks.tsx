import type { ReactNode } from "react"

import { DelegatedTaskDisplay } from "@/ui/conversation/delegation/DelegatedTaskDisplay"

import type { TAgentMessage, IAssistantMessage } from "@/agent"
import { MessageCard } from "@/ui/components/MessageCard"
import { ErrorNotice } from "@/ui/components/ErrorNotice"
import { AssistantMessagePart } from "@/ui/conversation/messages/AssistantMessagePart"
import { ToolCallDisplay } from "@/ui/conversation/tools/ToolCallDisplay"
import { isVisibleTool } from "@/ui/conversation/tools/tool-call-presentation"
import {
    EMPTY_TOOL_CALL_IDS,
    EMPTY_TOOL_RESULTS,
    type IToolActivityProjection,
} from "@/ui/conversation/tools/tool-call-matching"
import { theme } from "@/ui/terminal/theme"

export type VisualKind = "explorers" | "tool" | "file-tool" | "reasoning" | "text" | "user" | "diff" | "error" | "checkpoint"
export interface ITranscriptBlock {
    readonly key: string
    readonly kind: VisualKind
    readonly node: ReactNode
}
export interface IHistoryBlocks {
    readonly blocks: readonly ITranscriptBlock[]
    readonly positionsAfterMessage: ReadonlyMap<string, number>
}
function toolVisualKind(toolName: string): VisualKind {
    return toolName === "edit" || toolName === "write" ? "file-tool" : "tool"
}

export function buildHistoryBlocks(
    messages: readonly TAgentMessage[],
    projection: IToolActivityProjection,
    runningToolCallIds: ReadonlySet<string>,
    currentErrorMessageId: string | undefined,
    accentColor: string,
): IHistoryBlocks {
    const blocks: ITranscriptBlock[] = []
    const positionsAfterMessage = new Map<string, number>()
    for (const message of messages) {
        blocks.push(...messageBlocks(message, projection, runningToolCallIds, currentErrorMessageId, accentColor))
        // Invisible messages still provide valid checkpoint boundaries.
        positionsAfterMessage.set(message.id, blocks.length)
    }
    return { blocks, positionsAfterMessage }
}

/** Combines cached elements without moving live fragments beneath a different React parent. */
export function assembleBlocks(
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
    accentColor: string,
): ITranscriptBlock[] {
    switch (message.role) {
        case "user":
            return [{
                key: message.id,
                kind: "user",
                node: <MessageCard id={`user-message-${message.id}`} content={message.content} borderColor={accentColor} />,
            }]
        case "assistant":
            return assistantBlocks(message, false, projection, runningToolCallIds, currentErrorMessageId)
        case "toolResult":
            return projection.matchedToolResultMessageIds.has(message.id) || !isVisibleTool(message.toolName) || message.toolName === "delegate_task"
                ? []
                : [{ key: message.id, kind: toolVisualKind(message.toolName), node: <ToolCallDisplay result={message} /> }]
    }
}

export function assistantBlocks(
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
                node = <AssistantMessagePart kind="text" text={content.text} streaming={streaming} />
                break
            case "reasoning":
                if (!streaming && !content.text.trim()) continue
                kind = "reasoning"
                node = <AssistantMessagePart kind="reasoning" text={content.text} streaming={streaming} />
                break
            case "toolCall": {
                if (!isVisibleTool(content.toolName)) continue
                kind = toolVisualKind(content.toolName)
                const active = streaming || activeToolCallIds.has(content.toolCallId)
                const phase = active ? runningToolCallIds.has(content.toolCallId) ? "running" : "pending" : undefined
                if (content.toolName === "delegate_task") {
                    if (streaming) continue
                    kind = "explorers"
                    node = <DelegatedTaskDisplay
                        sessionId={message.sessionId} assistantMessageId={message.id} toolCallId={content.toolCallId} />
                } else {
                    node = <AssistantMessagePart kind="tool" call={content} result={toolResults.get(content.toolCallId)} phase={phase} />
                }
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
