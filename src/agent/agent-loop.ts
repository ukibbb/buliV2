import type { IAgentEvent } from "@/agent/events"
import type {
    IAssistantMessage,
    IToolCallContent,
    IUserMessage,
    TAgentMessage,
} from "@/agent/messages"
import type { IAgentModel } from "@/agent/model"
import { streamModelTurn } from "@/agent/model-turn"
import type {
    IModelProfile,
    TReasoningEffort,
} from "@/agent/model-values"
import type {
    IAgentLoopResult,
    TAgentRunEndReason,
} from "@/agent/state"
import type { IAgentTool } from "@/agent/tool"
import type {
    TToolApprovalDecision,
    TToolApprovalDraft,
} from "@/agent/tool-approval"
import {
    executeToolCallsSequentially,
    indexAgentTools,
} from "@/agent/tool-executor"
import {
    buildAgentTurnSystemPrompt,
    createAgentTurnAuthorization,
    type IAgentTurnAuthorization,
} from "@/agent/turn-policy"

interface IRunAgentLoopOptions {
    readonly sessionId: string
    readonly runId: string
    readonly systemPrompt: string
    readonly messages: readonly TAgentMessage[]
    readonly contextSummary?: string
    readonly prompt: IUserMessage
    readonly initialTurnAuthorization?: IAgentTurnAuthorization
    readonly model: IAgentModel
    readonly modelProfile?: IModelProfile
    readonly tools: readonly IAgentTool[]
    readonly reasoningEffort: TReasoningEffort
    readonly signal: AbortSignal
    readonly emit: (event: IAgentEvent) => void | Promise<void>
    readonly requestApproval?: (
        draft: TToolApprovalDraft,
        context: {
            readonly sessionId: string
            readonly runId: string
            readonly toolCallId: string
            readonly signal: AbortSignal
        },
    ) => Promise<TToolApprovalDecision>
    readonly hasSteeringMessages?: () => boolean
    readonly takeSteeringMessage?: () => IUserMessage | undefined
    readonly hasFollowUpMessages?: () => boolean
    readonly takeFollowUpMessage?: () => IUserMessage | undefined
    readonly restoreQueuedMessage?: (message: IUserMessage) => void
    readonly closeQueuedInput?: () => void
    readonly now?: () => number
    readonly generateId?: () => string
}

/** Orchestrates provider turns, queued input, and sequential local tool batches. */
export async function runAgentLoop(
    options: IRunAgentLoopOptions,
): Promise<IAgentLoopResult> {
    const now = options.now ?? Date.now
    const generateId = options.generateId ?? (() => crypto.randomUUID())
    // One registry keeps model descriptors and local executors in sync.
    const toolsByName = indexAgentTools(options.tools)
    const messages = structuredClone([...options.messages, options.prompt])
    const newMessages: TAgentMessage[] = [structuredClone(options.prompt)]
    let turnAuthorization = options.initialTurnAuthorization
        ?? createAgentTurnAuthorization(options.prompt, options.messages)

    await options.emit({ type: "agent_start", runId: options.runId })
    await options.emit({ type: "turn_start", runId: options.runId, index: 0 })
    await emitCompletedMessage(options.prompt, options.runId, options.emit)

    let continueForTools = false
    for (let iteration = 0; ; iteration += 1) {
        const steeringMessage = iteration > 0
            ? options.takeSteeringMessage?.()
            : undefined
        const followUpMessage = iteration > 0
            && !continueForTools
            && !steeringMessage
            ? options.takeFollowUpMessage?.()
            : undefined
        const queuedMessage = steeringMessage ?? followUpMessage
        const queuedAuthorization = queuedMessage
            ? createAgentTurnAuthorization(queuedMessage, messages)
            : undefined
        if (iteration > 0 && !continueForTools && !queuedMessage) {
            options.closeQueuedInput?.()
            return finishRun(
                "completed",
                newMessages,
                options.runId,
                options.emit,
            )
        }

        try {
            if (iteration > 0) {
                await options.emit({
                    type: "turn_start",
                    runId: options.runId,
                    index: iteration,
                })
            }

            if (queuedMessage) {
                await emitCompletedMessage(
                    queuedMessage,
                    options.runId,
                    options.emit,
                )
                messages.push(queuedMessage)
                newMessages.push(queuedMessage)
                if (queuedAuthorization) turnAuthorization = queuedAuthorization
            }
        } catch (error) {
            if (queuedMessage) {
                options.restoreQueuedMessage?.(queuedMessage)
            }
            throw error
        }

        const activeTools = [...toolsByName.values()].filter(
            (tool) => turnAuthorization.allowsTool(tool),
        )
        const assistant = await streamModelTurn({
            sessionId: options.sessionId,
            runId: options.runId,
            systemPrompt: buildAgentTurnSystemPrompt(
                options.systemPrompt,
                turnAuthorization,
                activeTools,
            ),
            ...(options.contextSummary === undefined
                ? {}
                : { contextSummary: options.contextSummary }),
            messages,
            model: options.model,
            ...(options.modelProfile === undefined
                ? {}
                : { modelProfile: options.modelProfile }),
            tools: activeTools,
            reasoningEffort: options.reasoningEffort,
            signal: options.signal,
            emit: options.emit,
            now,
            generateId,
        })
        // `messages` is the full model context; `newMessages` is this run's delta.
        messages.push(assistant)
        newMessages.push(assistant)

        const assistantRunReason = runReasonForAssistant(assistant)
        if (assistantRunReason) {
            options.closeQueuedInput?.()
            await options.emit({
                type: "turn_end",
                runId: options.runId,
                index: iteration,
                message: assistant,
                toolResults: [],
                willContinue: false,
            })
            return finishRun(
                options.signal.aborted ? "aborted" : assistantRunReason,
                newMessages,
                options.runId,
                options.emit,
            )
        }

        const toolCalls = assistant.content.filter(
            (content): content is IToolCallContent => content.type === "toolCall",
        )
        const toolResults = await executeToolCallsSequentially(
            toolCalls,
            toolsByName,
            {
                sessionId: options.sessionId,
                runId: options.runId,
                signal: options.signal,
                emit: options.emit,
                ...(options.requestApproval === undefined
                    ? {}
                    : { requestApproval: options.requestApproval }),
                authorization: turnAuthorization,
                now,
                generateId,
            },
        )

        for (const toolResult of toolResults) {
            messages.push(toolResult)
            newMessages.push(toolResult)
        }

        // Steering precedes follow-up, which waits until tool continuation ends.
        const hasSteeringMessages = options.hasSteeringMessages?.() ?? false
        const hasFollowUpMessages = options.hasFollowUpMessages?.() ?? false
        const wantsContinuation = toolResults.length > 0
            || hasSteeringMessages
            || hasFollowUpMessages
        const willContinue = wantsContinuation && !options.signal.aborted

        if (!willContinue) options.closeQueuedInput?.()

        await options.emit({
            type: "turn_end",
            runId: options.runId,
            index: iteration,
            message: assistant,
            toolResults,
            willContinue,
        })

        if (options.signal.aborted) {
            options.closeQueuedInput?.()
            return finishRun("aborted", newMessages, options.runId, options.emit)
        }
        if (!willContinue) {
            return finishRun("completed", newMessages, options.runId, options.emit)
        }
        continueForTools = toolResults.length > 0
    }
}

async function emitCompletedMessage(
    message: TAgentMessage,
    runId: string,
    emit: (event: IAgentEvent) => void | Promise<void>,
): Promise<void> {
    await emit({ type: "message_start", runId, message })
    await emit({ type: "message_end", runId, message })
}

function runReasonForAssistant(
    message: IAssistantMessage,
): TAgentRunEndReason | undefined {
    if (message.stopReason === "aborted") return "aborted"
    if (message.stopReason === "error") return "error"
    return undefined
}

async function finishRun(
    reason: TAgentRunEndReason,
    messages: readonly TAgentMessage[],
    runId: string,
    emit: (event: IAgentEvent) => void | Promise<void>,
): Promise<IAgentLoopResult> {
    const result = { reason, messages: structuredClone(messages) }
    await emit({ type: "agent_end", runId, ...result })
    return result
}
