import type { TAgentEvent } from "@/agent/events"
import type {
    TAgentMessage,
    IAssistantMessage,
    IToolCallContent,
    IUserMessage,
    IUserPathReference,
} from "@/agent/messages"
import { USER_PATH_REFERENCES_PER_SESSION_MAX } from "@/agent/messages"
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
import type { IToolOutputStore } from "@/agent/tool-output-store"
import type {
    TToolApprovalDecision,
    TToolApprovalDraft,
} from "@/agent/tool-approval"
import {
    executeToolCallsSequentially,
    failToolCallsWithoutExecution,
    indexAgentTools,
} from "@/agent/tool-executor"

const TRUNCATED_TOOL_CALL_MESSAGE =
    "Tool call was not executed because the model response reached its output token limit and its arguments may be incomplete. Re-issue the tool call with complete arguments."

export type TAgentEventSink = (event: TAgentEvent) => void | Promise<void>

export interface IAgentApprovalContext {
    readonly sessionId: string
    readonly runId: string
    readonly toolCallId: string
    readonly signal: AbortSignal
}

export type TAgentApprovalHandler = (
    draft: TToolApprovalDraft,
    context: IAgentApprovalContext,
) => Promise<TToolApprovalDecision>

export interface IAgentInputQueue {
    hasSteering(): boolean
    takeSteering(): IUserMessage | undefined
    hasFollowUp(): boolean
    takeFollowUp(): IUserMessage | undefined
    restore(message: IUserMessage): void
    close(): void
}

export interface IAgentContext {
    readonly systemPrompt: string
    readonly messages: readonly TAgentMessage[]
    readonly contextSummary?: string
    readonly tools: readonly IAgentTool[]
    readonly selectedPathReferences?: readonly IUserPathReference[]
}

export interface IAgentLoopConfig {
    readonly sessionId: string
    readonly runId: string
    readonly model: IAgentModel
    readonly modelProfile?: IModelProfile
    readonly providerAccountId?: string
    readonly reasoningEffort: TReasoningEffort
    readonly signal: AbortSignal
    readonly emit: TAgentEventSink
    readonly requestApproval?: TAgentApprovalHandler
    readonly inputQueue?: IAgentInputQueue
    readonly now?: () => number
    readonly generateId?: () => string
    readonly toolOutputStore?: IToolOutputStore
}

/** Orchestrates provider turns, queued input, and sequential local tool batches. */
export async function runAgentLoop(
    prompt: IUserMessage,
    context: IAgentContext,
    config: IAgentLoopConfig,
): Promise<IAgentLoopResult> {
    const now = config.now ?? Date.now
    const generateId = config.generateId ?? (() => crypto.randomUUID())
    // One registry keeps model descriptors and local executors in sync.
    const toolsByName = indexAgentTools(context.tools)
    const activeTools = [...toolsByName.values()]
    const messages = structuredClone([...context.messages, prompt])
    const newMessages: TAgentMessage[] = [structuredClone(prompt)]
    const selectedPathReferences = mergePathReferences(
        [],
        context.selectedPathReferences ?? [],
    )
    let providerAccountId = config.providerAccountId

    await config.emit({ type: "agent_start", runId: config.runId })
    await config.emit({ type: "turn_start", runId: config.runId, index: 0 })
    await emitCompletedMessage(prompt, config.runId, config.emit)

    let iteration = 0
    let pendingMessage: IUserMessage | undefined

    // The outer loop resumes completed agent work when a follow-up arrives.
    while (true) {
        // The first pass starts the run; later passes continue only for tools or steering.
        let hasMoreToolCalls = iteration === 0

        while (true) {
            const steeringMessage = iteration > 0 && !pendingMessage
                ? config.inputQueue?.takeSteering()
                : undefined
            const queuedMessage = pendingMessage ?? steeringMessage
            pendingMessage = undefined

            if (iteration > 0 && !hasMoreToolCalls && !queuedMessage) break

            try {
                if (iteration > 0) {
                    await config.emit({
                        type: "turn_start",
                        runId: config.runId,
                        index: iteration,
                    })
                }

                if (queuedMessage) {
                    await emitCompletedMessage(
                        queuedMessage,
                        config.runId,
                        config.emit,
                    )
                    messages.push(queuedMessage)
                    newMessages.push(queuedMessage)
                    mergePathReferences(
                        selectedPathReferences,
                        queuedMessage.references ?? [],
                    )
                }
            } catch (error) {
                if (queuedMessage) {
                    config.inputQueue?.restore(queuedMessage)
                }
                throw error
            }

            const assistant = await streamModelTurn({
                sessionId: config.sessionId,
                runId: config.runId,
                systemPrompt: context.systemPrompt,
                ...(context.contextSummary === undefined
                    ? {}
                    : { contextSummary: context.contextSummary }),
                messages,
                model: config.model,
                ...(config.modelProfile === undefined
                    ? {}
                    : { modelProfile: config.modelProfile }),
                tools: activeTools,
                reasoningEffort: config.reasoningEffort,
                reportProviderAccountId: (accountId) => {
                    providerAccountId = accountId
                },
                signal: config.signal,
                emit: config.emit,
                now,
                generateId,
            })
            // `messages` is the full model context; `newMessages` is this run's delta.
            messages.push(assistant)
            newMessages.push(assistant)

            const assistantRunReason = runReasonForAssistant(assistant)
            if (assistantRunReason) {
                config.inputQueue?.close()
                await config.emit({
                    type: "turn_end",
                    runId: config.runId,
                    index: iteration,
                    message: assistant,
                    toolResults: [],
                    willContinue: false,
                })
                return finishRun(
                    config.signal.aborted ? "aborted" : assistantRunReason,
                    newMessages,
                    config.runId,
                    config.emit,
                )
            }

            const toolCalls = assistant.content.filter(
                (content): content is IToolCallContent => content.type === "toolCall",
            )
            const toolExecutionOptions = {
                sessionId: config.sessionId,
                runId: config.runId,
                ...(config.modelProfile === undefined
                    ? {}
                    : { modelProfile: config.modelProfile }),
                ...(providerAccountId === undefined
                    ? {}
                    : { providerAccountId }),
                messages,
                selectedPathReferences,
                signal: config.signal,
                emit: config.emit,
                ...(config.requestApproval === undefined
                    ? {}
                    : { requestApproval: config.requestApproval }),
                now,
                generateId,
                ...(config.toolOutputStore === undefined
                    ? {}
                    : { toolOutputStore: config.toolOutputStore }),
            }
            const toolResults = assistant.stopReason === "length"
                ? await failToolCallsWithoutExecution(
                    toolCalls,
                    TRUNCATED_TOOL_CALL_MESSAGE,
                    toolExecutionOptions,
                )
                : await executeToolCallsSequentially(
                    toolCalls,
                    toolsByName,
                    toolExecutionOptions,
                )

            for (const toolResult of toolResults) {
                messages.push(toolResult)
                newMessages.push(toolResult)
            }

            // Steering precedes follow-up, which waits until tool continuation ends.
            const hasSteeringMessages = config.inputQueue?.hasSteering() ?? false
            const hasFollowUpMessages = config.inputQueue?.hasFollowUp() ?? false
            const wantsContinuation = toolResults.length > 0
                || hasSteeringMessages
                || hasFollowUpMessages
            const willContinue = wantsContinuation && !config.signal.aborted

            if (!willContinue) config.inputQueue?.close()

            await config.emit({
                type: "turn_end",
                runId: config.runId,
                index: iteration,
                message: assistant,
                toolResults,
                willContinue,
            })

            if (config.signal.aborted) {
                config.inputQueue?.close()
                return finishRun(
                    "aborted",
                    newMessages,
                    config.runId,
                    config.emit,
                )
            }
            if (!willContinue) {
                return finishRun(
                    "completed",
                    newMessages,
                    config.runId,
                    config.emit,
                )
            }

            hasMoreToolCalls = toolResults.length > 0
            iteration += 1
        }

        const followUpMessage = config.inputQueue?.takeFollowUp()
        if (!followUpMessage) {
            config.inputQueue?.close()
            return finishRun(
                "completed",
                newMessages,
                config.runId,
                config.emit,
            )
        }
        pendingMessage = followUpMessage
    }
}

function mergePathReferences(
    target: IUserPathReference[],
    additions: readonly IUserPathReference[],
): IUserPathReference[] {
    for (const reference of additions) {
        const key = `${reference.kind}\0${reference.path}`
        const existingIndex = target.findIndex((candidate) => (
            `${candidate.kind}\0${candidate.path}` === key
        ))
        if (existingIndex >= 0) target.splice(existingIndex, 1)
        target.push(structuredClone(reference))
        if (target.length > USER_PATH_REFERENCES_PER_SESSION_MAX) target.shift()
    }
    return target
}

async function emitCompletedMessage(
    message: TAgentMessage,
    runId: string,
    emit: TAgentEventSink,
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
    emit: TAgentEventSink,
): Promise<IAgentLoopResult> {
    const result = { reason, messages: structuredClone(messages) }
    await emit({ type: "agent_end", runId, ...result })
    return result
}
