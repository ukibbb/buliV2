import { Buffer } from "node:buffer"
import type { TSchema } from "typebox"
import { Value } from "typebox/value"

import type { TAgentEvent } from "@/agent/events"
import type {
    TAgentMessage,
    IToolCallContent,
    IToolResultMessage,
    IUserPathReference,
} from "@/agent/messages"
import type { IModelProfile } from "@/agent/model-values"
import type {
    IRuntimeAgentTool,
    TToolExecutionOutcome,
} from "@/agent/tool"
import {
    isToolOutputWithinLimits,
    MAX_TOOL_OUTPUT_BYTES,
    MAX_TOOL_OUTPUT_LINES,
    truncateToolOutput,
} from "@/agent/engine/tool-output"
import type { IToolOutputStore } from "@/agent/tool-output-store"

const COMMITTED_AFTER_ABORT_SUMMARY =
    "WARNING: Workspace changes were committed despite cancellation."
const SIDE_EFFECTS_UNKNOWN_SUMMARY =
    "WARNING: Tool side effects are unknown; inspect current state before retrying."

interface IExecuteToolCallsOptions {
    readonly sessionId: string
    readonly runId: string
    readonly modelProfile?: IModelProfile
    readonly providerAccountId?: string
    readonly messages: readonly TAgentMessage[]
    readonly selectedPathReferences?: readonly IUserPathReference[]
    readonly signal: AbortSignal
    readonly emit: (event: TAgentEvent) => void | Promise<void>
    readonly now: () => number
    readonly generateId: () => string
    readonly toolOutputStore?: IToolOutputStore
}

export function createToolIndex(
    tools: readonly IRuntimeAgentTool[],
): ReadonlyMap<string, IRuntimeAgentTool> {
    const toolsByName = new Map<string, IRuntimeAgentTool>()
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
    toolsByName: ReadonlyMap<string, IRuntimeAgentTool>,
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

/** Publishes error results for tool calls that must not reach local executors. */
export async function failToolCallsWithoutExecution(
    toolCalls: readonly IToolCallContent[],
    content: string,
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
        const result: IToolResultMessage = {
            id: options.generateId(),
            sessionId: options.sessionId,
            runId: options.runId,
            role: "toolResult",
            toolCallId: toolCall.toolCallId,
            toolName: toolCall.toolName,
            content: truncateToolOutput(content),
            isError: true,
            createdAt: options.now(),
        }
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
    toolsByName: ReadonlyMap<string, IRuntimeAgentTool>,
    options: IExecuteToolCallsOptions,
): Promise<IToolResultMessage> {
    let content: string
    let isError: boolean
    let outcome: TToolExecutionOutcome | undefined
    let summary: string | undefined
    let diff: string | undefined
    const tool = toolsByName.get(toolCall.toolName)

    if (options.signal.aborted) {
        content = abortReason(options.signal)
        isError = true
    } else if (!tool) {
        content = `Unknown tool: ${toolCall.toolName}`
        isError = true
    } else {
        let acceptingProgress = true
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
            void progressTask.catch(() => { })
        }
        try {
            const preparedInput = tool.prepareArguments
                ? tool.prepareArguments(structuredClone(toolCall.input))
                : structuredClone(toolCall.input)
            normalizeOptionalNulls(
                preparedInput,
                tool.inputSchema as IJsonSchemaNode,
            )
            const executionResult = normalizeToolExecutionResult(
                tool.name,
                await tool.validateAndExecute(preparedInput, {
                    sessionId: options.sessionId,
                    toolCallId: toolCall.toolCallId,
                    runId: options.runId,
                    ...(options.modelProfile === undefined
                        ? {}
                        : { modelProfile: structuredClone(options.modelProfile) }),
                    ...(tool.requiresConversationContext
                        ? {
                            ...(options.providerAccountId === undefined
                                ? {}
                                : {
                                    providerAccountId:
                                        options.providerAccountId,
                                }),
                            messages: structuredClone(options.messages),
                        }
                        : {}),
                    ...(tool.acceptsSelectedPathReferences
                        && options.selectedPathReferences?.length
                        ? {
                            selectedPathReferences: structuredClone(
                                options.selectedPathReferences,
                            ),
                        }
                        : {}),
                    signal: options.signal,
                    reportProgress,
                }),
            )
            content = executionResult.content
            outcome = executionResult.outcome
            summary = executionResult.summary
            diff = executionResult.diff
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
        }
        await progressTask
    }

    if (!tool?.selfTruncatesOutput) {
        const retained = await retainCompleteToolOutput({
            content,
            summary,
            isError,
            outcome,
            toolCall,
            options,
        })
        content = retained.content
        summary = retained.summary
        isError = retained.isError
        outcome = retained.outcome
    }

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
        ...(diff === undefined ? {} : { diff }),
        createdAt: options.now(),
    }
}

async function retainCompleteToolOutput(input: {
    readonly content: string
    readonly summary: string | undefined
    readonly isError: boolean
    readonly outcome: TToolExecutionOutcome | undefined
    readonly toolCall: IToolCallContent
    readonly options: IExecuteToolCallsOptions
}): Promise<{
    readonly content: string
    readonly summary: string | undefined
    readonly isError: boolean
    readonly outcome: TToolExecutionOutcome | undefined
}> {
    const contentFits = isToolOutputWithinLimits(input.content)
    const summaryFits = input.summary === undefined
        || isToolOutputWithinLimits(input.summary)
    if (contentFits && summaryFits) {
        return {
            content: input.content,
            summary: input.summary,
            isError: input.isError,
            outcome: input.outcome,
        }
    }

    const store = input.options.toolOutputStore
    if (!store) {
        return unavailableLargeOutput(
            "No complete tool-output store is configured",
            input.outcome,
        )
    }

    try {
        const stored = await store.store({
            sessionId: input.options.sessionId,
            runId: input.options.runId,
            toolCallId: input.toolCall.toolCallId,
            toolName: input.toolCall.toolName,
        }, {
            content: input.content,
            ...(input.summary === undefined ? {} : { summary: input.summary }),
        })
        const header = `Complete tool result stored as outputId=${JSON.stringify(stored.outputId)}. Use tool_output with this outputId and part="content" to read exact pages.`
        return {
            content: storedPreview(header, input.content),
            summary: input.summary === undefined
                ? undefined
                : summaryFits
                    ? input.summary
                    : `Complete summary stored as outputId=${JSON.stringify(stored.outputId)} with part="summary".`,
            isError: input.isError,
            outcome: input.outcome,
        }
    } catch (error) {
        return unavailableLargeOutput(
            `Complete tool output could not be stored: ${errorMessage(error)}`,
            input.outcome,
        )
    }
}

function storedPreview(header: string, output: string): string {
    const headerBytes = Buffer.byteLength(header, "utf8") + 1
    return `${header}\n${truncateToolOutput(output, {
        maxBytes: MAX_TOOL_OUTPUT_BYTES - headerBytes,
        maxLines: MAX_TOOL_OUTPUT_LINES - 1,
    })}`
}

function unavailableLargeOutput(
    reason: string,
    previousOutcome: TToolExecutionOutcome | undefined,
): {
    readonly content: string
    readonly summary: string
    readonly isError: true
    readonly outcome: TToolExecutionOutcome
} {
    const warning = "The complete result is unavailable and this response must not be treated as complete. Inspect possible side effects before deciding whether it is safe to rerun the source tool."
    const prefix = `${warning}\nReason: `
    return {
        content: prefix + truncateToolOutput(reason, {
            maxBytes: MAX_TOOL_OUTPUT_BYTES - Buffer.byteLength(prefix, "utf8"),
            maxLines: MAX_TOOL_OUTPUT_LINES - 1,
        }),
        summary: "Complete tool output unavailable",
        isError: true,
        outcome: previousOutcome === "completed"
            ? "effects-unknown"
            : previousOutcome === "committed-after-abort"
                || previousOutcome === "effects-unknown"
                ? previousOutcome
                : "failed",
    }
}

interface IJsonSchemaNode {
    readonly properties?: Readonly<Record<string, IJsonSchemaNode>>
    readonly required?: readonly string[]
    readonly items?: IJsonSchemaNode | IJsonSchemaNode[]
    readonly $ref?: unknown
}

/** Matches Pi's treatment of null sent for optional, non-nullable arguments. */
function normalizeOptionalNulls(
    value: unknown,
    schema: IJsonSchemaNode,
): void {
    if (Array.isArray(value)) {
        if (Array.isArray(schema.items)) {
            for (const [index, item] of value.entries()) {
                const itemSchema = schema.items[index]
                if (itemSchema) normalizeOptionalNulls(item, itemSchema)
            }
        } else if (schema.items) {
            for (const item of value) normalizeOptionalNulls(item, schema.items)
        }
        return
    }
    if (value === null || typeof value !== "object" || !schema.properties) {
        return
    }

    const object = value as Record<string, unknown>
    const required = new Set(schema.required ?? [])
    for (const [key, propertySchema] of Object.entries(schema.properties)) {
        if (!(key in object)) continue
        if (
            object[key] === null
            && !required.has(key)
            && typeof propertySchema.$ref !== "string"
            && rejectsNull(propertySchema)
        ) {
            delete object[key]
        } else {
            normalizeOptionalNulls(object[key], propertySchema)
        }
    }
}

function rejectsNull(schema: IJsonSchemaNode): boolean {
    try {
        return !Value.Check(schema as TSchema, null)
    } catch {
        return false
    }
}

function normalizeToolExecutionResult(
    toolName: string,
    value: unknown,
): {
    readonly content: string
    readonly outcome: TToolExecutionOutcome
    readonly summary?: string
    readonly diff?: string
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

    if (result.diff !== undefined && typeof result.diff !== "string") {
        throw new TypeError(`Tool "${toolName}" result diff must be a string`)
    }

    return {
        content: result.content,
        outcome: result.outcome ?? "completed",
        ...(result.summary === undefined ? {} : { summary: result.summary }),
        ...(result.diff === undefined ? {} : { diff: result.diff }),
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

async function emitCompletedMessage(
    message: IToolResultMessage,
    runId: string,
    emit: (event: TAgentEvent) => void | Promise<void>,
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
