import { AssistantMessageBuilder } from "@/agent/assistant-message-builder"
import type {
  IAgentEvent,
  IAgentLoopResult,
  IAgentModel,
  IAgentTool,
  IAgentToolDescriptor,
  TAgentRunEndReason,
} from "@/agent/agent-types"
import type {
  IAssistantMessage,
  IToolCallContent,
  IToolResultMessage,
  TAgentMessage,
} from "@/domain"

const DEFAULT_MAX_PROVIDER_ITERATIONS = 5

interface IRunAgentLoopOptions {
  readonly sessionId: string
  readonly systemPrompt: string
  readonly messages: readonly TAgentMessage[]
  readonly prompt: TAgentMessage
  readonly model: IAgentModel
  readonly tools: readonly IAgentTool[]
  readonly signal: AbortSignal
  readonly emit: (event: IAgentEvent) => void | Promise<void>
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
  const messages = structuredClone([...options.messages, options.prompt])
  const newMessages: TAgentMessage[] = [structuredClone(options.prompt)]

  await options.emit({ type: "agent_start" })
  await options.emit({ type: "turn_start", index: 0 })
  await emitCompletedMessage(options.prompt, options.emit)

  for (let iteration = 0; iteration < maximumIterations; iteration += 1) {
    if (iteration > 0) {
      await options.emit({ type: "turn_start", index: iteration })
    }

    const assistant = await streamAssistantMessage(
      messages,
      options,
      now,
      generateId,
    )
    messages.push(assistant)
    newMessages.push(assistant)

    const assistantRunReason = runReasonForAssistant(assistant)
    if (assistantRunReason) {
      await options.emit({
        type: "turn_end",
        index: iteration,
        message: assistant,
        toolResults: [],
        willContinue: false,
      })
      return finishRun(assistantRunReason, newMessages, options.emit)
    }

    const toolCalls = assistant.content.filter(
      (content): content is IToolCallContent => content.type === "toolCall",
    )
    const toolResults = await executeToolCallsSequentially(
      toolCalls,
      options,
      now,
      generateId,
    )

    for (const toolResult of toolResults) {
      messages.push(toolResult)
      newMessages.push(toolResult)
    }

    const reachedLimit = toolResults.length > 0
      && iteration + 1 >= maximumIterations
    const runReason = options.signal.aborted
      ? "aborted"
      : reachedLimit
        ? "max-iterations"
        : undefined
    const willContinue = toolResults.length > 0 && runReason === undefined

    await options.emit({
      type: "turn_end",
      index: iteration,
      message: assistant,
      toolResults,
      willContinue,
    })

    if (runReason) return finishRun(runReason, newMessages, options.emit)
    if (!willContinue) return finishRun("completed", newMessages, options.emit)
  }

  return finishRun("max-iterations", newMessages, options.emit)
}

async function streamAssistantMessage(
  messages: readonly TAgentMessage[],
  options: IRunAgentLoopOptions,
  now: () => number,
  generateId: () => string,
): Promise<IAssistantMessage> {
  const builder = new AssistantMessageBuilder({
    sessionId: options.sessionId,
    now,
    generateId,
  })
  await options.emit({ type: "message_start", message: builder.snapshot() })

  try {
    const tools: IAgentToolDescriptor[] = options.tools.map((agentTool) => ({
      name: agentTool.name,
      description: agentTool.description,
      inputSchema: structuredClone(agentTool.inputSchema),
    }))
    const stream = options.model.stream({
      sessionId: options.sessionId,
      systemPrompt: options.systemPrompt,
      messages: structuredClone(messages),
      tools,
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
    builder.finish("stop")
  }

  const assistant = builder.snapshot()
  await options.emit({ type: "message_end", message: assistant })
  return assistant
}

async function executeToolCallsSequentially(
  toolCalls: readonly IToolCallContent[],
  options: IRunAgentLoopOptions,
  now: () => number,
  generateId: () => string,
): Promise<IToolResultMessage[]> {
  const results: IToolResultMessage[] = []

  for (const toolCall of toolCalls) {
    await options.emit({
      type: "tool_execution_start",
      toolCallId: toolCall.toolCallId,
      toolName: toolCall.toolName,
      input: structuredClone(toolCall.input),
    })

    const result = await executeToolCall(toolCall, options, now, generateId)
    await options.emit({
      type: "tool_execution_end",
      toolCallId: toolCall.toolCallId,
      toolName: toolCall.toolName,
      result,
    })
    await emitCompletedMessage(result, options.emit)
    results.push(result)
  }

  return results
}

async function executeToolCall(
  toolCall: IToolCallContent,
  options: IRunAgentLoopOptions,
  now: () => number,
  generateId: () => string,
): Promise<IToolResultMessage> {
  let content: string
  let isError: boolean
  const tool = options.tools.find(
    (candidate) => candidate.name === toolCall.toolName,
  )

  if (options.signal.aborted) {
    content = abortReason(options.signal)
    isError = true
  } else if (!tool) {
    content = `Unknown tool: ${toolCall.toolName}`
    isError = true
  } else {
    try {
      content = await tool.execute(structuredClone(toolCall.input), {
        toolCallId: toolCall.toolCallId,
        signal: options.signal,
      })
      options.signal.throwIfAborted()
      isError = false
    } catch (error) {
      content = options.signal.aborted
        ? abortReason(options.signal)
        : errorMessage(error)
      isError = true
    }
  }

  return {
    id: generateId(),
    sessionId: options.sessionId,
    role: "toolResult",
    toolCallId: toolCall.toolCallId,
    toolName: toolCall.toolName,
    content,
    isError,
    createdAt: now(),
  }
}

async function emitCompletedMessage(
  message: TAgentMessage,
  emit: (event: IAgentEvent) => void | Promise<void>,
): Promise<void> {
  await emit({ type: "message_start", message })
  await emit({ type: "message_end", message })
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
  emit: (event: IAgentEvent) => void | Promise<void>,
): Promise<IAgentLoopResult> {
  const result = { reason, messages: structuredClone(messages) }
  await emit({ type: "agent_end", ...result })
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
