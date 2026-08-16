import { Agent } from "@/agent/agent"
import type {
    IAgentEvent,
    IAgentRunHandle,
    IAgentState,
    IAgentTool,
    TAgentRunConfigurationResolver,
} from "@/agent/agent-types"
import type { ISessionSnapshot, TAgentMessage } from "@/domain"
import {
    createInterruptedToolResults,
    freezeSessionSnapshot,
    type ISessionManager,
} from "@/session/session-manager"

interface IAgentSessionOptions {
    readonly agentId: string
    readonly sessionId: string
    readonly manager: ISessionManager
    readonly systemPrompt: string
    readonly resolveRunConfiguration: TAgentRunConfigurationResolver
    readonly tools: readonly IAgentTool[]
    readonly maxProviderIterations?: number
    readonly now?: () => number
    readonly generateId?: () => string
    readonly disposeTimeoutMs?: number
}

interface IQueuedSessionMessages {
    readonly steering: readonly string[]
    readonly followUp: readonly string[]
}

type TSessionListener = () => void
const DEFAULT_DISPOSE_TIMEOUT_MS = 5_000

/** Connects one live Agent to durable history and UI subscriptions. */
export class AgentSession {
    readonly agentId: string
    readonly id: string
    private readonly agent: Agent
    private readonly manager: ISessionManager
    private readonly listeners = new Set<TSessionListener>()
    private readonly unsubscribeAgent: () => void
    private readonly disposeTimeoutMs: number
    private snapshot: ISessionSnapshot
    private disposed = false
    private disposeTask: Promise<void> | undefined
    private persistenceError: unknown
    private acceptCriticalEvents = true

    constructor(options: IAgentSessionOptions) {
        this.agentId = options.agentId
        this.id = options.sessionId
        this.manager = options.manager
        this.disposeTimeoutMs = options.disposeTimeoutMs ?? DEFAULT_DISPOSE_TIMEOUT_MS
        if (!Number.isFinite(this.disposeTimeoutMs) || this.disposeTimeoutMs <= 0) {
            throw new Error("disposeTimeoutMs must be a positive finite number")
        }
        const initialMessages = this.loadDurableHistory()
        this.agent = new Agent({
            // agent for sessionId
            sessionId: options.sessionId,
            // it's system prompt
            systemPrompt: options.systemPrompt,
            resolveRunConfiguration: options.resolveRunConfiguration,
            tools: options.tools,
            criticalEventSink: (event) => {
                if (!this.acceptCriticalEvents) {
                    throw new Error("AgentSession stopped accepting events during shutdown")
                }
                if (event.type === "message_end") {
                    try {
                        this.manager.appendMessage(event.message)
                    } catch (error) {
                        this.persistenceError = error
                        throw error
                    }
                }
            },
            onObserverError: (error) => {
                console.error("Agent observer failed", error)
            },
            // ?? what initial messages are?
            // To trwała historia tej samej sesji odczytana z managera podczas
            // tworzenia Agenta. Zawiera wcześniejsze wiadomości `user`, zakończone
            // wiadomości `assistant` oraz `toolResult`, ale nie `systemPrompt`,
            // bieżący prompt ani aktualnie streamowaną odpowiedź. Agent klonuje tę
            // historię do swojego stanu i używa jej jako kontekstu kolejnych requestów.
            initialMessages,
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

    prompt(text: string): IAgentRunHandle {
        if (this.disposed) throw new Error("AgentSession is disposed")
        if (this.persistenceError !== undefined) {
            throw new Error(
                "Session persistence failed. Clear or reopen the session before submitting another prompt.",
                { cause: this.persistenceError },
            )
        }
        return this.agent.prompt(text)
    }

    steer(text: string): void {
        if (this.disposed) throw new Error("AgentSession is disposed")
        if (this.persistenceError !== undefined) {
            throw new Error(
                "Session persistence failed. Clear or reopen the session before submitting another prompt.",
                { cause: this.persistenceError },
            )
        }
        this.agent.steer(text)
        this.publishSnapshot()
    }

    followUp(text: string): void {
        if (this.disposed) throw new Error("AgentSession is disposed")
        if (this.persistenceError !== undefined) {
            throw new Error(
                "Session persistence failed. Clear or reopen the session before submitting another prompt.",
                { cause: this.persistenceError },
            )
        }
        this.agent.followUp(text)
        this.publishSnapshot()
    }

    clearQueuedMessages(): IQueuedSessionMessages {
        if (this.disposed) throw new Error("AgentSession is disposed")
        const messages = this.agent.clearQueuedMessages()
        if (messages.steering.length > 0 || messages.followUp.length > 0) {
            this.publishSnapshot()
        }
        return {
            steering: messages.steering.map((message) => message.content),
            followUp: messages.followUp.map((message) => message.content),
        }
    }

    async abort(): Promise<void> {
        if (this.disposed) return
        await this.agent.abort()
    }

    waitForIdle(): Promise<void> {
        return this.agent.waitForIdle()
    }

    clear(): void {
        if (this.disposed) throw new Error("AgentSession is disposed")
        if (this.agent.state.isRunning) {
            throw new Error("Cannot clear while AgentSession is running")
        }

        this.manager.clearSession(this.id)
        this.agent.clear()
        this.persistenceError = undefined
        this.publishSnapshot()
    }

    dispose(): Promise<void> {
        this.disposeTask ??= this.disposeInternal()
        return this.disposeTask
    }

    private async disposeInternal(): Promise<void> {
        if (this.disposed) return
        this.disposed = true
        try {
            await withTimeout(
                this.agent.abort(),
                this.disposeTimeoutMs,
                "Timed out waiting for AgentSession to stop",
            )
        } finally {
            this.acceptCriticalEvents = false
            this.unsubscribeAgent()
            this.listeners.clear()
        }
    }

    private handleAgentEvent(event: IAgentEvent): void {
        if (event.type === "agent_settled" && event.reason === "internal-error") {
            try {
                this.agent.restoreMessages(this.loadDurableHistory())
                this.persistenceError = undefined
            } catch (error) {
                this.persistenceError = error
            }
        }
        this.publishSnapshot()
    }

    private loadDurableHistory(): readonly TAgentMessage[] {
        const messages = this.manager.getMessages(this.id)
        const recoveries = createInterruptedToolResults(messages)
        for (const recovery of recoveries) {
            this.manager.appendMessage(recovery)
        }
        return this.manager.getMessages(this.id)
    }

    private publishSnapshot(): void {
        this.snapshot = this.createSnapshot()
        for (const listener of [...this.listeners]) {
            try {
                listener()
            } catch (error) {
                console.error("Session observer failed", error)
            }
        }
    }

    private createSnapshot(): ISessionSnapshot {
        const state = this.agent.state

        return freezeSessionSnapshot({
            messages: state.messages,
            pendingSteeringMessages: this.agent.pendingSteeringMessages,
            pendingFollowUpMessages: this.agent.pendingFollowUpMessages,
            ...(state.streamingMessage
                ? { streamingMessage: state.streamingMessage }
                : {}),
            isRunning: state.isRunning,
            ...(state.activeRunId ? { activeRunId: state.activeRunId } : {}),
            pendingToolCallIds: [...state.pendingToolCallIds],
            ...(state.lastRunReason ? { lastRunReason: state.lastRunReason } : {}),
            ...(state.errorMessage ? { errorMessage: state.errorMessage } : {}),
        })
    }
}

async function withTimeout(
    task: Promise<void>,
    timeoutMs: number,
    message: string,
): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined
    const timeoutTask = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs)
    })
    try {
        await Promise.race([task, timeoutTask])
    } finally {
        if (timeout) clearTimeout(timeout)
    }
}
