import type { IBuliMessageWithParts, IToolPart, TJsonValue } from "@/domain"
import { AssistantMessageBuilder } from "@/agent/assistant-message-builder"
import type {
  IAgentEvent,
  IAgentLoopResult,
  IAgentModel,
  IAgentTool,
  IAgentToolDescriptor,
  TAgentRunEndReason,
  TToolExecutionOutcome,
} from "@/agent/agent-types"

const DEFAULT_MAX_PROVIDER_ITERATIONS = 5

interface IRunAgentLoopOptions {
  readonly sessionId: string
  readonly systemPrompt: string
  readonly history: readonly IBuliMessageWithParts[]
  readonly prompt: IBuliMessageWithParts
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
  const maxProviderIterations = options.maxProviderIterations
    ?? DEFAULT_MAX_PROVIDER_ITERATIONS
  const context = structuredClone([...options.history, options.prompt])
  const newMessages: IBuliMessageWithParts[] = [structuredClone(options.prompt)]

  await options.emit({ type: "agent_start" })
  await options.emit({ type: "turn_start", index: 0 })
  await options.emit({ type: "message_start", message: options.prompt })
  await options.emit({ type: "message_end", message: options.prompt })

  for (let iteration = 0; iteration < maxProviderIterations; iteration += 1) {
    if (iteration > 0) {
      await options.emit({ type: "turn_start", index: iteration })
    }

    const builder = new AssistantMessageBuilder({
      sessionId: options.sessionId,
      now,
      generateId,
    })
    await options.emit({ type: "message_start", message: builder.snapshot() })

    await consumeModelStream(builder, options, context)

    if (!builder.completed && !options.signal.aborted) {
      await executeLocalTools(builder, options)
    }

    const reason = completeAssistant(builder, options.signal)
    const assistant = builder.snapshot()
    context.push(structuredClone(assistant))
    newMessages.push(structuredClone(assistant))
    await options.emit({ type: "message_end", message: assistant })

    const hasLocalToolContinuation = reason === undefined
      && assistant.parts.some(
        (part) => part.type === "tool" && part.execution === "local",
      )
    const reachedLimit = hasLocalToolContinuation
      && iteration + 1 >= maxProviderIterations
    const runReason = reason ?? (reachedLimit ? "max-iterations" : undefined)
    const willContinue = hasLocalToolContinuation && runReason === undefined

    await options.emit({
      type: "turn_end",
      index: iteration,
      message: assistant,
      willContinue,
    })

    if (runReason) {
      return finishRun(runReason, newMessages, options.emit)
    }
    if (!willContinue) {
      return finishRun("completed", newMessages, options.emit)
    }
  }

  return finishRun("max-iterations", newMessages, options.emit)
}

async function consumeModelStream(
  builder: AssistantMessageBuilder,
  options: IRunAgentLoopOptions,
  context: readonly IBuliMessageWithParts[],
): Promise<void> {
  try {
    const tools: IAgentToolDescriptor[] = options.tools.map((agentTool) => ({
      name: agentTool.name,
      description: agentTool.description,
      inputSchema: structuredClone(agentTool.inputSchema),
    }))
    const stream = options.model.stream({
      sessionId: options.sessionId,
      systemPrompt: options.systemPrompt,
      history: structuredClone(context),
      tools,
      signal: options.signal,
    })

    for await (const event of stream) {
      const changed = builder.applyModelEvent(event)
      if (changed) {
        await options.emit({
          type: "message_update",
          message: builder.snapshot(),
        })
      }
      if (builder.completed || event.type === "finish") break
    }
  } catch (error) {
    if (options.signal.aborted) {
      builder.completeAborted(abortReason(options.signal))
    } else {
      builder.completeFailed(error)
    }
  }
}

async function executeLocalTools(
  builder: AssistantMessageBuilder,
  options: IRunAgentLoopOptions,
): Promise<void> {
  const calls = builder.pendingLocalTools()
  if (calls.length === 0) return

  for (const call of calls) {
    await options.emit({
      type: "tool_execution_start",
      toolCallID: call.callID,
      toolName: call.tool,
      input: structuredClone(call.input),
    })
    builder.markToolRunning(call.callID)
    await options.emit({ type: "message_update", message: builder.snapshot() })
  }

  await Promise.all(calls.map(async (call) => {
    const outcome = await executeLocalTool(call, options)
    if (outcome.status === "completed") {
      builder.completeTool(call.callID, call.input, outcome.output)
    } else if (outcome.status === "cancelled") {
      builder.cancelTool(call.callID, call.input, outcome.error)
    } else {
      builder.failTool(call.callID, call.input, outcome.error)
    }

    await options.emit({
      type: "tool_execution_end",
      toolCallID: call.callID,
      toolName: call.tool,
      input: structuredClone(call.input),
      outcome,
    })
    await options.emit({ type: "message_update", message: builder.snapshot() })
  }))
}

async function executeLocalTool(
  call: IToolPart,
  options: IRunAgentLoopOptions,
): Promise<TToolExecutionOutcome> {
  if (options.signal.aborted) {
    return { status: "cancelled", error: abortReason(options.signal) }
  }

  const tool = options.tools.find((candidate) => candidate.name === call.tool)
  if (!tool) return { status: "error", error: `Unknown tool: ${call.tool}` }

  try {
    const output: TJsonValue = await tool.execute(
      structuredClone(call.input),
      { toolCallID: call.callID, signal: options.signal },
    )
    options.signal.throwIfAborted()
    return { status: "completed", output: structuredClone(output) }
  } catch (error) {
    if (options.signal.aborted) {
      return { status: "cancelled", error: abortReason(options.signal) }
    }
    return { status: "error", error: errorMessage(error) }
  }
}

function completeAssistant(
  builder: AssistantMessageBuilder,
  signal: AbortSignal,
): TAgentRunEndReason | undefined {
  if (builder.completed) {
    const message = builder.snapshot()
    const finish = message.info.role === "assistant"
      ? message.info.finish
      : undefined
    return finish === "abort" ? "aborted" : finish === "error" ? "error" : undefined
  }
  if (signal.aborted) {
    builder.completeAborted(abortReason(signal))
    return "aborted"
  }
  builder.completeNormally()
  return undefined
}

async function finishRun(
  reason: TAgentRunEndReason,
  messages: readonly IBuliMessageWithParts[],
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
