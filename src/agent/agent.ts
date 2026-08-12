import { generateRandomId } from "@/common"
import type { IBuliMessageWithParts } from "@/domain"
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
  readonly initialMessages?: readonly IBuliMessageWithParts[]
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
      pendingToolCallIDs: new Set(),
      error: undefined,
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
      pendingToolCallIDs: new Set(),
      error: undefined,
      lastRunReason: undefined,
    }

    try {
      await runAgentLoop({
        sessionId: this.stateValue.sessionId,
        systemPrompt: this.stateValue.systemPrompt,
        history: this.stateValue.messages,
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
          pendingToolCallIDs: new Set(),
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
      pendingToolCallIDs: new Set(),
      error: undefined,
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
          streamingMessage: undefined,
        }
        return
      case "tool_execution_start": {
        const pendingToolCallIDs = new Set(this.stateValue.pendingToolCallIDs)
        pendingToolCallIDs.add(event.toolCallID)
        this.stateValue = { ...this.stateValue, pendingToolCallIDs }
        return
      }
      case "tool_execution_end": {
        const pendingToolCallIDs = new Set(this.stateValue.pendingToolCallIDs)
        pendingToolCallIDs.delete(event.toolCallID)
        this.stateValue = { ...this.stateValue, pendingToolCallIDs }
        return
      }
      case "turn_end":
        this.stateValue = {
          ...this.stateValue,
          error: event.message.info.role === "assistant"
            ? event.message.info.error
            : undefined,
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

  private createUserMessage(text: string): IBuliMessageWithParts {
    const messageId = this.generateId()
    const createdAt = this.now()
    return {
      info: {
        id: messageId,
        sessionId: this.stateValue.sessionId,
        role: "user",
        createdAt,
      },
      parts: [{
        id: this.generateId(),
        messageId,
        sessionId: this.stateValue.sessionId,
        createdAt,
        type: "text",
        text,
      }],
    }
  }
}
