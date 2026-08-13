import { generateRandomId } from "@/common"
import type { TAgentMessage } from "@/domain"
import { runAgentLoop } from "@/agent/agent-loop"
import type {
  IAgentEvent,
  IAgentModel,
  IAgentState,
  IAgentTool,
  TAgentEventListener,
} from "@/agent/agent-types"

interface IAgentOptions {
  readonly sessionId: string
  readonly systemPrompt: string
  readonly model: IAgentModel
  readonly tools: readonly IAgentTool[]
  readonly initialMessages?: readonly TAgentMessage[]
  readonly maxProviderIterations?: number
  readonly now?: () => number
  readonly generateId?: () => string
}

interface IActiveAgentRun {
  readonly abortController: AbortController
  readonly settled: Promise<void>
  readonly resolveSettled: () => void
}

/** Owns one session's live agent state and active run. */
export class Agent {
  private stateValue: IAgentState
  private readonly model: IAgentModel
  private readonly listeners = new Set<TAgentEventListener>()
  private readonly maxProviderIterations: number | undefined
  private readonly now: () => number
  private readonly generateId: () => string
  private activeRun: IActiveAgentRun | undefined

  constructor(options: IAgentOptions) {
    this.model = options.model
    this.maxProviderIterations = options.maxProviderIterations
    this.now = options.now ?? Date.now
    this.generateId = options.generateId ?? generateRandomId
    this.stateValue = {
      sessionId: options.sessionId,
      systemPrompt: options.systemPrompt,
      tools: [...options.tools],
      messages: structuredClone(options.initialMessages ?? []),
      isRunning: false,
      streamingMessage: undefined,
      pendingToolCallIds: new Set(),
      errorMessage: undefined,
      lastRunReason: undefined,
    }
  }

  get state(): IAgentState {
    return this.stateValue
  }

  subscribe(listener: TAgentEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async prompt(text: string): Promise<void> {
    if (!text.trim()) return
    if (this.activeRun) {
      throw new Error("Agent is already processing a prompt")
    }

    const abortController = new AbortController()
    const settled = Promise.withResolvers<void>()
    const activeRun: IActiveAgentRun = {
      abortController,
      settled: settled.promise,
      resolveSettled: settled.resolve,
    }
    this.activeRun = activeRun
    this.stateValue = {
      ...this.stateValue,
      isRunning: true,
      streamingMessage: undefined,
      pendingToolCallIds: new Set(),
      errorMessage: undefined,
      lastRunReason: undefined,
    }

    try {
      await runAgentLoop({
        sessionId: this.stateValue.sessionId,
        systemPrompt: this.stateValue.systemPrompt,
        messages: this.stateValue.messages,
        prompt: this.createUserMessage(text),
        model: this.model,
        tools: this.stateValue.tools,
        signal: abortController.signal,
        emit: (event) => this.processEvent(event, abortController.signal),
        ...(this.maxProviderIterations === undefined
          ? {}
          : { maxProviderIterations: this.maxProviderIterations }),
        now: this.now,
        generateId: this.generateId,
      })
    } finally {
      if (this.activeRun === activeRun) {
        this.stateValue = {
          ...this.stateValue,
          isRunning: false,
          streamingMessage: undefined,
          pendingToolCallIds: new Set(),
        }
        this.activeRun = undefined
        activeRun.resolveSettled()
      }
    }
  }

  abort(): void {
    this.activeRun?.abortController.abort("Buli interaction was aborted")
  }

  waitForIdle(): Promise<void> {
    return this.activeRun?.settled ?? Promise.resolve()
  }

  reset(): void {
    if (this.activeRun) throw new Error("Cannot reset while Agent is running")
    this.stateValue = {
      ...this.stateValue,
      messages: [],
      isRunning: false,
      streamingMessage: undefined,
      pendingToolCallIds: new Set(),
      errorMessage: undefined,
      lastRunReason: undefined,
    }
  }

  private async processEvent(
    event: IAgentEvent,
    signal: AbortSignal,
  ): Promise<void> {
    this.reduce(event)
    for (const listener of this.listeners) await listener(event, signal)
  }

  private reduce(event: IAgentEvent): void {
    switch (event.type) {
      case "agent_start":
        this.stateValue = { ...this.stateValue, isRunning: true }
        return
      case "message_start":
        if (event.message.role !== "assistant") return
        this.stateValue = {
          ...this.stateValue,
          streamingMessage: structuredClone(event.message),
        }
        return
      case "message_update":
        this.stateValue = {
          ...this.stateValue,
          streamingMessage: structuredClone(event.message),
        }
        return
      case "message_end":
        this.stateValue = {
          ...this.stateValue,
          messages: [...this.stateValue.messages, structuredClone(event.message)],
          streamingMessage: event.message.role === "assistant"
            ? undefined
            : this.stateValue.streamingMessage,
        }
        return
      case "tool_execution_start": {
        const pendingToolCallIds = new Set(this.stateValue.pendingToolCallIds)
        pendingToolCallIds.add(event.toolCallId)
        this.stateValue = { ...this.stateValue, pendingToolCallIds }
        return
      }
      case "tool_execution_end": {
        const pendingToolCallIds = new Set(this.stateValue.pendingToolCallIds)
        pendingToolCallIds.delete(event.toolCallId)
        this.stateValue = { ...this.stateValue, pendingToolCallIds }
        return
      }
      case "turn_end":
        this.stateValue = {
          ...this.stateValue,
          errorMessage: event.message.errorMessage,
        }
        return
      case "agent_end":
        this.stateValue = {
          ...this.stateValue,
          isRunning: false,
          streamingMessage: undefined,
          lastRunReason: event.reason,
        }
        return
      case "turn_start":
        return
    }
  }

  private createUserMessage(text: string): TAgentMessage {
    return {
      id: this.generateId(),
      sessionId: this.stateValue.sessionId,
      role: "user",
      content: text,
      createdAt: this.now(),
    }
  }
}
