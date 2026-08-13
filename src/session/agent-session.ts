import { Agent } from "@/agent/agent"
import type {
  IAgentEvent,
  IAgentModel,
  IAgentState,
  IAgentTool,
} from "@/agent/agent-types"
import type { ISessionSnapshot } from "@/domain"
import {
  freezeSessionSnapshot,
  type ISessionManager,
} from "@/session/session-manager"

interface IAgentSessionOptions {
  readonly sessionId: string
  readonly manager: ISessionManager
  readonly systemPrompt: string
  readonly model: IAgentModel
  readonly tools: readonly IAgentTool[]
  readonly maxProviderIterations?: number
  readonly now?: () => number
  readonly generateId?: () => string
}

type TSessionListener = () => void

/** Connects one live Agent to durable history and UI subscriptions. */
export class AgentSession {
  readonly id: string
  private readonly agent: Agent
  private readonly manager: ISessionManager
  private readonly listeners = new Set<TSessionListener>()
  private readonly unsubscribeAgent: () => void
  private snapshot: ISessionSnapshot
  private disposed = false

  constructor(options: IAgentSessionOptions) {
    this.id = options.sessionId
    this.manager = options.manager
    this.agent = new Agent({
      sessionId: options.sessionId,
      systemPrompt: options.systemPrompt,
      model: options.model,
      tools: options.tools,
      initialMessages: options.manager.getMessages(options.sessionId),
      ...(options.maxProviderIterations === undefined
        ? {}
        : { maxProviderIterations: options.maxProviderIterations }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.generateId === undefined
        ? {}
        : { generateId: options.generateId }),
    })
    this.snapshot = this.createSnapshot()
    this.unsubscribeAgent = this.agent.subscribe((event) => {
      this.handleAgentEvent(event)
    })
  }

  get state(): IAgentState {
    return this.agent.state
  }

  readonly getSnapshot = (): ISessionSnapshot => this.snapshot

  readonly subscribe = (listener: TSessionListener): (() => void) => {
    if (this.disposed) throw new Error("AgentSession is disposed")
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  prompt(text: string): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("AgentSession is disposed"))
    return this.agent.prompt(text)
  }

  abort(): void {
    if (this.disposed) return
    this.agent.abort()
  }

  waitForIdle(): Promise<void> {
    return this.agent.waitForIdle()
  }

  reset(): void {
    if (this.disposed) throw new Error("AgentSession is disposed")
    if (this.agent.state.isRunning) {
      throw new Error("Cannot reset while AgentSession is running")
    }

    this.manager.resetSession(this.id)
    this.agent.reset()
    this.publishSnapshot()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.agent.abort()
    this.unsubscribeAgent()
    this.listeners.clear()
  }

  private handleAgentEvent(event: IAgentEvent): void {
    if (event.type === "message_end") {
      this.manager.appendMessage(event.message)
    }
    this.publishSnapshot()
  }

  private publishSnapshot(): void {
    this.snapshot = this.createSnapshot()
    for (const listener of [...this.listeners]) listener()
  }

  private createSnapshot(): ISessionSnapshot {
    const state = this.agent.state

    return freezeSessionSnapshot({
      messages: state.messages,
      ...(state.streamingMessage
        ? { streamingMessage: state.streamingMessage }
        : {}),
      isRunning: state.isRunning,
      pendingToolCallIds: [...state.pendingToolCallIds],
      ...(state.lastRunReason ? { lastRunReason: state.lastRunReason } : {}),
    })
  }
}
