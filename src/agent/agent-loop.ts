import type { AgentEvent } from "@/agent/events"
import type {
    AgentMessage,
    AssistantMessage,
    ToolCallContent,
    UserMessage,
    UserPathReference,
} from "@/agent/messages"
import { USER_PATH_REFERENCES_PER_SESSION_MAX } from "@/agent/messages"
import type { AgentModel } from "@/agent/model"
import { streamModelTurn } from "@/agent/model-turn"
import type {
    ModelProfile,
    ReasoningEffort,
} from "@/agent/model-values"
import type {
    AgentLoopResult,
    AgentRunEndReason,
} from "@/agent/state"
import type { AgentTool } from "@/agent/tool"
import type {
    ToolApprovalDecision,
    ToolApprovalDraft,
} from "@/agent/tool-approval"
import {
    executeToolCallsSequentially,
    failToolCallsWithoutExecution,
    indexAgentTools,
} from "@/agent/tool-executor"

const TRUNCATED_TOOL_CALL_MESSAGE =
    "Tool call was not executed because the model response reached its output token limit and its arguments may be incomplete. Re-issue the tool call with complete arguments."

export type AgentEventSink = (event: AgentEvent) => void | Promise<void>

export interface AgentApprovalContext {
    readonly sessionId: string
    readonly runId: string
    readonly toolCallId: string
    readonly signal: AbortSignal
}

export type AgentApprovalHandler = (
    draft: ToolApprovalDraft,
    context: AgentApprovalContext,
) => Promise<ToolApprovalDecision>

export interface AgentInputQueue {
    hasSteering(): boolean
    takeSteering(): UserMessage | undefined
    hasFollowUp(): boolean
    takeFollowUp(): UserMessage | undefined
    restore(message: UserMessage): void
    close(): void
}

export interface AgentContext {
    readonly systemPrompt: string
    readonly messages: readonly AgentMessage[]
    readonly contextSummary?: string
    readonly tools: readonly AgentTool[]
    readonly selectedPathReferences?: readonly UserPathReference[]
}

export interface AgentLoopConfig {
    readonly sessionId: string
    readonly runId: string
    readonly model: AgentModel
    readonly modelProfile?: ModelProfile
    readonly providerAccountId?: string
    readonly reasoningEffort: ReasoningEffort
    readonly signal: AbortSignal
    readonly emit: AgentEventSink
    readonly requestApproval?: AgentApprovalHandler
    readonly inputQueue?: AgentInputQueue
    readonly now?: () => number
    readonly generateId?: () => string
}

/** Orchestrates provider turns, queued input, and sequential local tool batches. */
export async function runAgentLoop(
    prompt: UserMessage,
    context: AgentContext,
    config: AgentLoopConfig,
): Promise<AgentLoopResult> {
    const now = config.now ?? Date.now
    const generateId = config.generateId ?? (() => crypto.randomUUID())
    // One registry keeps model descriptors and local executors in sync.
    const toolsByName = indexAgentTools(context.tools)
    const activeTools = [...toolsByName.values()]
    const messages = structuredClone([...context.messages, prompt])
    const newMessages: AgentMessage[] = [structuredClone(prompt)]
    const selectedPathReferences = mergePathReferences(
        [],
        context.selectedPathReferences ?? [],
    )
    let providerAccountId = config.providerAccountId

    await config.emit({ type: "agent_start", runId: config.runId })
    await config.emit({ type: "turn_start", runId: config.runId, index: 0 })
    await emitCompletedMessage(prompt, config.runId, config.emit)

    let iteration = 0
    let pendingMessage: UserMessage | undefined

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
                (content): content is ToolCallContent => content.type === "toolCall",
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
    target: UserPathReference[],
    additions: readonly UserPathReference[],
): UserPathReference[] {
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
    message: AgentMessage,
    runId: string,
    emit: AgentEventSink,
): Promise<void> {
    await emit({ type: "message_start", runId, message })
    await emit({ type: "message_end", runId, message })
}

function runReasonForAssistant(
    message: AssistantMessage,
): AgentRunEndReason | undefined {
    if (message.stopReason === "aborted") return "aborted"
    if (message.stopReason === "error") return "error"
    return undefined
}

async function finishRun(
    reason: AgentRunEndReason,
    messages: readonly AgentMessage[],
    runId: string,
    emit: AgentEventSink,
): Promise<AgentLoopResult> {
    const result = { reason, messages: structuredClone(messages) }
    await emit({ type: "agent_end", runId, ...result })
    return result
}
