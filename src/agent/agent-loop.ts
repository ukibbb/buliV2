import { Value } from "typebox/value"

import { AssistantMessageBuilder } from "@/agent/assistant-message-builder"
import { truncateToolOutput } from "@/agent/tool-output"
import type {
    IAgentEvent,
    IAgentLoopResult,
    IAgentModel,
    IAgentTool,
    IAgentToolDescriptor,
    TAgentRunEndReason,
    TReasoningEffort,
} from "@/agent/agent-types"
import type {
    IAssistantMessage,
    IModelProfile,
    IToolCallContent,
    IToolResultMessage,
    IUserMessage,
    TAgentMessage,
} from "@/domain"

const DEFAULT_MAX_PROVIDER_ITERATIONS = 5

interface IRunAgentLoopOptions {
    readonly sessionId: string
    readonly runId: string
    readonly systemPrompt: string
    readonly messages: readonly TAgentMessage[]
    readonly contextSummary?: string
    readonly prompt: TAgentMessage
    readonly model: IAgentModel
    readonly modelProfile?: IModelProfile
    readonly tools: readonly IAgentTool[]
    readonly reasoningEffort: TReasoningEffort
    readonly signal: AbortSignal
    readonly emit: (event: IAgentEvent) => void | Promise<void>
    readonly hasSteeringMessages?: () => boolean
    readonly takeSteeringMessage?: () => IUserMessage | undefined
    readonly hasFollowUpMessages?: () => boolean
    readonly takeFollowUpMessage?: () => IUserMessage | undefined
    readonly restoreQueuedMessage?: (message: IUserMessage) => void
    readonly closeQueuedInput?: () => void
    readonly maxProviderIterations?: number
    readonly now?: () => number
    readonly generateId?: () => string
}

/** Runs provider turns and local tools without owning long-lived state. */
export async function runAgentLoop(
    options: IRunAgentLoopOptions,
): Promise<IAgentLoopResult> {
    const now = options.now ?? Date.now
    const generateId = options.generateId ?? (() => crypto.randomUUID())
    const maximumIterations = options.maxProviderIterations
        ?? DEFAULT_MAX_PROVIDER_ITERATIONS
    // Jedna mapa jest wspólnym źródłem descriptorów i lokalnych executorów.
    // Odrzucenie duplikatu zapobiega sytuacji, w której model widzi inny tool
    // niż ten znaleziony później przez hosta.
    const toolsByName = indexTools(options.tools)
    const messages = structuredClone([...options.messages, options.prompt])
    const newMessages: TAgentMessage[] = [structuredClone(options.prompt)]

    await options.emit({ type: "agent_start", runId: options.runId })
    await options.emit({ type: "turn_start", runId: options.runId, index: 0 })
    await emitCompletedMessage(options.prompt, options.runId, options.emit)

    let continueForTools = false
    for (let iteration = 0; iteration < maximumIterations; iteration += 1) {
        const steeringMessage = iteration > 0
            ? options.takeSteeringMessage?.()
            : undefined
        const followUpMessage = iteration > 0
            && !continueForTools
            && !steeringMessage
            ? options.takeFollowUpMessage?.()
            : undefined
        const queuedMessage = steeringMessage ?? followUpMessage
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
            }
        } catch (error) {
            if (queuedMessage) {
                options.restoreQueuedMessage?.(queuedMessage)
            }
            throw error
        }

        const assistant = await streamAssistantMessage(
            messages,
            options,
            toolsByName,
            now,
            generateId,
        )
        // ?? Why messages and newMessages - what is the difference?
        // `messages` to pełny roboczy kontekst modelu: stara historia, bieżący
        // prompt oraz wszystkie odpowiedzi i wyniki narzędzi z tego uruchomienia.
        // Jest przekazywany modelowi ponownie przy każdej następnej iteracji.
        // `newMessages` to tylko przyrost bieżącego uruchomienia, bez starej historii;
        // trafia do wyniku pętli i eventu `agent_end`. Odpowiedź dodajemy do obu:
        // model może jej potrzebować w kolejnej iteracji, a wynik ma ją raportować.
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
            options,
            toolsByName,
            now,
            generateId,
        )

        for (const toolResult of toolResults) {
            messages.push(toolResult)
            newMessages.push(toolResult)
        }

        // Steering nie przerywa odpowiedzi ani tool calli i ma pierwszeństwo
        // przy następnym requestcie. Follow-up czeka jeszcze dłużej: pętla użyje
        // go dopiero wtedy, gdy nie zostało ani tool continuation, ani steering.
        const hasSteeringMessages = options.hasSteeringMessages?.() ?? false
        const hasFollowUpMessages = options.hasFollowUpMessages?.() ?? false
        const wantsContinuation = toolResults.length > 0
            || hasSteeringMessages
            || hasFollowUpMessages
        const reachedLimit = wantsContinuation
            && iteration + 1 >= maximumIterations

        const runReason = options.signal.aborted
            ? "aborted"
            : reachedLimit
                ? "max-iterations"
                : undefined

        const willContinue = wantsContinuation && runReason === undefined

        if (runReason || !willContinue) options.closeQueuedInput?.()

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
        if (runReason) {
            return finishRun(runReason, newMessages, options.runId, options.emit)
        }
        if (!willContinue) {
            return finishRun("completed", newMessages, options.runId, options.emit)
        }
        continueForTools = toolResults.length > 0
    }

    options.closeQueuedInput?.()
    return finishRun("max-iterations", newMessages, options.runId, options.emit)
}

async function streamAssistantMessage(
    messages: readonly TAgentMessage[],
    options: IRunAgentLoopOptions,
    toolsByName: ReadonlyMap<string, IAgentTool>,
    now: () => number,
    generateId: () => string,
): Promise<IAssistantMessage> {
    const builder = new AssistantMessageBuilder({
        sessionId: options.sessionId,
        runId: options.runId,
        now,
        generateId,
        ...(options.modelProfile === undefined
            ? {}
            : { modelProfile: options.modelProfile }),
    })
    await options.emit({
        type: "message_start",
        runId: options.runId,
        message: builder.snapshot(),
    })

    try {
        const tools: IAgentToolDescriptor[] = [...toolsByName.values()].map((agentTool) => ({
            name: agentTool.name,
            description: agentTool.description,
            inputSchema: structuredClone(agentTool.inputSchema),
        }))
        const stream = options.model.stream({
            sessionId: options.sessionId,
            runId: options.runId,
            systemPrompt: options.systemPrompt,
            ...(options.contextSummary === undefined
                ? {}
                : { contextSummary: options.contextSummary }),
            messages: structuredClone(messages),
            tools,
            reasoningEffort: options.reasoningEffort,
            signal: options.signal,
        })

        for await (const modelEvent of stream) {
            builder.apply(modelEvent)
            if (
                modelEvent.type !== "finish"
                && modelEvent.type !== "abort"
                && modelEvent.type !== "error"
            ) {
                await options.emit({
                    type: "message_update",
                    runId: options.runId,
                    message: builder.snapshot(),
                    modelEvent,
                })
            }
            if (builder.completed) break
        }
    } catch (error) {
        if (options.signal.aborted) {
            builder.abort(abortReason(options.signal))
        } else {
            builder.finish("error", errorMessage(error))
        }
    }

    if (options.signal.aborted) {
        builder.abort(abortReason(options.signal))
    } else if (!builder.completed) {
        builder.finish("error", "Model stream ended without a terminal event")
    }

    const assistant = builder.snapshot()
    await options.emit({
        type: "message_end",
        runId: options.runId,
        message: assistant,
    })
    return assistant
}

async function executeToolCallsSequentially(
    toolCalls: readonly IToolCallContent[],
    options: IRunAgentLoopOptions,
    toolsByName: ReadonlyMap<string, IAgentTool>,
    now: () => number,
    generateId: () => string,
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

        const result = await executeToolCall(
            toolCall,
            options,
            toolsByName,
            now,
            generateId,
        )
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
    options: IRunAgentLoopOptions,
    toolsByName: ReadonlyMap<string, IAgentTool>,
    now: () => number,
    generateId: () => string,
): Promise<IToolResultMessage> {
    let content: string
    let isError: boolean
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
            // Aktualizacje są kolejkowane, aby zachować kolejność nawet wtedy, gdy
            // observer wykonuje pracę asynchroniczną. Błąd `emit` pozostaje błędem
            // infrastruktury runu, a nie zwykłym niepowodzeniem narzędzia.
            progressTask = progressTask.then(async () => options.emit({
                type: "tool_execution_update",
                runId: options.runId,
                toolCallId: toolCall.toolCallId,
                toolName: toolCall.toolName,
                progress,
            }))
            void progressTask.catch(() => {})
        }

        try {
            const input = structuredClone(toolCall.input)
            assertToolInput(tool, input)
            content = await tool.execute(input, {
                toolCallId: toolCall.toolCallId,
                runId: options.runId,
                signal: options.signal,
                reportProgress,
            })
            if (typeof content !== "string") {
                throw new TypeError(`Tool "${tool.name}" must return a string`)
            }
            options.signal.throwIfAborted()
            isError = false
        } catch (error) {
            content = options.signal.aborted
                ? abortReason(options.signal)
                : errorMessage(error)
            isError = true
        } finally {
            acceptingProgress = false
        }
        await progressTask
    }

    // Limit jest stosowany centralnie, więc obejmuje także custom tools i błędy.
    // Do modelu, eventu końcowego i persistence trafia dokładnie ta sama treść.
    content = truncateToolOutput(content)

    return {
        id: generateId(),
        sessionId: options.sessionId,
        runId: options.runId,
        role: "toolResult",
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        content,
        isError,
        createdAt: now(),
    }
}

function indexTools(tools: readonly IAgentTool[]): ReadonlyMap<string, IAgentTool> {
    const toolsByName = new Map<string, IAgentTool>()
    for (const tool of tools) {
        if (toolsByName.has(tool.name)) throw new Error(`Duplicate tool: ${tool.name}`)
        toolsByName.set(tool.name, tool)
    }
    return toolsByName
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

function abortReason(signal: AbortSignal): string {
    if (signal.reason instanceof Error) return signal.reason.message
    return typeof signal.reason === "string"
        ? signal.reason
        : "Buli interaction was aborted"
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
