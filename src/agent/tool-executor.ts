import { Value } from "typebox/value"

import type { IAgentEvent } from "@/agent/events"
import type {
    IToolCallContent,
    IToolResultMessage,
} from "@/agent/messages"
import type {
    TToolApprovalDecision,
    TToolApprovalDraft,
} from "@/agent/tool-approval"
import type {
    IAgentTool,
    TToolExecutionOutcome,
} from "@/agent/tool"
import { truncateToolOutput } from "@/agent/tool-output"

const COMMITTED_AFTER_ABORT_SUMMARY =
    "WARNING: Workspace changes were committed despite cancellation."
const SIDE_EFFECTS_UNKNOWN_SUMMARY =
    "WARNING: Tool side effects are unknown; inspect current state before retrying."

interface IExecuteToolCallsOptions {
    readonly sessionId: string
    readonly runId: string
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
    readonly now: () => number
    readonly generateId: () => string
}

/** Builds the single validated tool registry shared by model and local execution. */
export function indexAgentTools(
    tools: readonly IAgentTool[],
): ReadonlyMap<string, IAgentTool> {
    const toolsByName = new Map<string, IAgentTool>()
    for (const tool of tools) {
        if (toolsByName.has(tool.name)) {
            throw new Error(`Duplicate tool: ${tool.name}`)
        }
        toolsByName.set(tool.name, tool)
    }
    return toolsByName
}

/** Executes local tool calls sequentially and publishes each result lifecycle. */
export async function executeToolCallsSequentially(
    toolCalls: readonly IToolCallContent[],
    toolsByName: ReadonlyMap<string, IAgentTool>,
    options: IExecuteToolCallsOptions,
): Promise<IToolResultMessage[]> {
    const results: IToolResultMessage[] = []

    for (const toolCall of toolCalls) {
        await options.emit({
            type: "tool_execution_start",
            runId: options.runId,
            toolCallId: toolCall.toolCallId,
            toolName: toolCall.toolName,
            input: structuredClone(toolCall.input),
        })

        const result = await executeToolCall(toolCall, toolsByName, options)
        await options.emit({
            type: "tool_execution_end",
            runId: options.runId,
            toolCallId: toolCall.toolCallId,
            toolName: toolCall.toolName,
            result,
        })
        await emitCompletedMessage(result, options.runId, options.emit)
        results.push(result)
    }

    return results
}

async function executeToolCall(
    toolCall: IToolCallContent,
    toolsByName: ReadonlyMap<string, IAgentTool>,
    options: IExecuteToolCallsOptions,
): Promise<IToolResultMessage> {
    let content: string
    let isError: boolean
    let outcome: TToolExecutionOutcome | undefined
    let summary: string | undefined
    const tool = toolsByName.get(toolCall.toolName)

    if (options.signal.aborted) {
        content = abortReason(options.signal)
        isError = true
    } else if (!tool) {
        content = `Unknown tool: ${toolCall.toolName}`
        isError = true
    } else {
        let acceptingProgress = true
        let acceptingApprovals = true
        let pendingApprovalTask: Promise<TToolApprovalDecision> | undefined
        let progressTask: Promise<void> = Promise.resolve()
        const reportProgress = (progress: string): void => {
            if (!acceptingProgress) return
            // Queue updates so asynchronous observers still receive them in order.
            progressTask = progressTask.then(async () => options.emit({
                type: "tool_execution_update",
                runId: options.runId,
                toolCallId: toolCall.toolCallId,
                toolName: toolCall.toolName,
                progress,
            }))
            void progressTask.catch(() => {})
        }
        const requestApproval = (
            draft: TToolApprovalDraft,
        ): Promise<TToolApprovalDecision> => {
            if (!acceptingApprovals) {
                return Promise.reject(new Error(
                    `Tool "${tool.name}" is no longer accepting approval requests`,
                ))
            }
            if (pendingApprovalTask) {
                return Promise.reject(new Error(
                    `Tool "${tool.name}" already has a pending approval request`,
                ))
            }
            if (!options.requestApproval) {
                return Promise.reject(new Error(
                    "Tool approval is not available in this agent loop",
                ))
            }

            let task: Promise<TToolApprovalDecision>
            try {
                options.signal.throwIfAborted()
                task = Promise.resolve(options.requestApproval(
                    structuredClone(draft),
                    {
                        sessionId: options.sessionId,
                        runId: options.runId,
                        toolCallId: toolCall.toolCallId,
                        signal: options.signal,
                    },
                ))
            } catch (error) {
                return Promise.reject(error)
            }

            pendingApprovalTask = task
            void task.then(
                () => {
                    if (pendingApprovalTask === task) {
                        pendingApprovalTask = undefined
                    }
                },
                () => {
                    if (pendingApprovalTask === task) {
                        pendingApprovalTask = undefined
                    }
                },
            )
            return task
        }

        try {
            const input = structuredClone(toolCall.input)
            assertToolInput(tool, input)
            const executionResult = normalizeToolExecutionResult(
                tool.name,
                await tool.execute(input, {
                    toolCallId: toolCall.toolCallId,
                    runId: options.runId,
                    signal: options.signal,
                    reportProgress,
                    requestApproval,
                }),
            )
            content = executionResult.content
            outcome = executionResult.outcome
            summary = executionResult.summary
            isError = outcome === "failed"
                || outcome === "committed-after-abort"
                || outcome === "effects-unknown"
        } catch (error) {
            if (options.signal.aborted && isCommittedError(error)) {
                content = errorMessage(error)
                outcome = "committed-after-abort"
                summary = COMMITTED_AFTER_ABORT_SUMMARY
            } else if (isUnknownSideEffectsError(error)) {
                content = errorMessage(error)
                outcome = "effects-unknown"
                summary = SIDE_EFFECTS_UNKNOWN_SUMMARY
            } else {
                content = options.signal.aborted
                    ? abortReason(options.signal)
                    : errorMessage(error)
                outcome = undefined
                summary = undefined
            }
            isError = true
        } finally {
            acceptingProgress = false
            acceptingApprovals = false
            const approvalTask = pendingApprovalTask
            if (approvalTask) await approvalTask.catch(() => {})
        }
        await progressTask
    }

    // Apply limits once so the model, final event, and persistence see one value.
    content = truncateToolOutput(content)
    if (summary !== undefined) summary = truncateToolOutput(summary)

    return {
        id: options.generateId(),
        sessionId: options.sessionId,
        runId: options.runId,
        role: "toolResult",
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        content,
        isError,
        ...(outcome === undefined ? {} : { outcome }),
        ...(summary === undefined ? {} : { summary }),
        createdAt: options.now(),
    }
}

function normalizeToolExecutionResult(
    toolName: string,
    value: unknown,
): {
    readonly content: string
    readonly outcome: TToolExecutionOutcome
    readonly summary?: string
} {
    if (typeof value === "string") {
        return { content: value, outcome: "completed" }
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new TypeError(
            `Tool "${toolName}" must return a string or structured result`,
        )
    }

    const result = value as Record<string, unknown>
    if (typeof result.content !== "string") {
        throw new TypeError(`Tool "${toolName}" result content must be a string`)
    }
    if (
        result.outcome !== undefined
        && !isToolExecutionOutcome(result.outcome)
    ) {
        throw new TypeError(`Tool "${toolName}" result outcome is invalid`)
    }
    if (result.summary !== undefined && typeof result.summary !== "string") {
        throw new TypeError(`Tool "${toolName}" result summary must be a string`)
    }

    return {
        content: result.content,
        outcome: result.outcome ?? "completed",
        ...(result.summary === undefined ? {} : { summary: result.summary }),
    }
}

function isToolExecutionOutcome(value: unknown): value is TToolExecutionOutcome {
    return value === "completed"
        || value === "rejected"
        || value === "manual"
        || value === "failed"
        || value === "committed-after-abort"
        || value === "effects-unknown"
}

function isCommittedError(error: unknown): boolean {
    return error !== null
        && typeof error === "object"
        && "committed" in error
        && error.committed === true
}

function isUnknownSideEffectsError(error: unknown): boolean {
    return error !== null
        && typeof error === "object"
        && "sideEffectsUnknown" in error
        && error.sideEffectsUnknown === true
}

function assertToolInput(
    tool: IAgentTool,
    input: Record<string, unknown>,
): void {
    if (Value.Check(tool.inputSchema, input)) return

    const details = Value.Errors(tool.inputSchema, input)
        .slice(0, 3)
        .map((error) => `${error.instancePath || "/"}: ${error.message}`)
        .join("; ")
    throw new TypeError(
        `Invalid input for tool "${tool.name}": ${details || "schema validation failed"}`,
    )
}

async function emitCompletedMessage(
    message: IToolResultMessage,
    runId: string,
    emit: (event: IAgentEvent) => void | Promise<void>,
): Promise<void> {
    await emit({ type: "message_start", runId, message })
    await emit({ type: "message_end", runId, message })
}

function abortReason(signal: AbortSignal): string {
    if (signal.reason instanceof Error) return signal.reason.message
    return typeof signal.reason === "string"
        ? signal.reason
        : "Buli interaction was aborted"
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
