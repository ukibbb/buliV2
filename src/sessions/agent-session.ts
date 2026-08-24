import {
    Agent,
    type IAgentEvent,
    type IAgentRunHandle,
    type IAgentState,
    type IAgentTool,
    type TAgentMessage,
    type TAgentRunConfigurationResolver,
    type TToolApprovalDecision,
} from "@/agent"
import { generateRandomId } from "@/common/ids"
import type { ICompactionCheckpoint } from "@/sessions/compaction/checkpoint"
import { projectAgentContext } from "@/sessions/compaction/context-projector"
import { compactSessionMessages } from "@/sessions/compaction/session-compactor"
import { createInterruptedToolResults } from "@/sessions/recovery"
import type { ISessionManager } from "@/sessions/repository"
import {
    freezeSessionSnapshot,
    type ISessionSnapshot,
} from "@/sessions/snapshot"


const DEFAULT_DISPOSE_TIMEOUT_MS = 5_000
const DEFAULT_AUTO_COMPACTION_THRESHOLD = 0.8

interface IAgentSessionOptions {
    readonly agentId: string
    readonly sessionId: string
    readonly manager: ISessionManager
    readonly systemPrompt: string
    readonly resolveRunConfiguration: TAgentRunConfigurationResolver
    readonly tools: readonly IAgentTool[]
    readonly now?: () => number
    readonly generateId?: () => string
    readonly disposeTimeoutMs?: number
    readonly autoCompactionThreshold?: number
}

interface IQueuedSessionMessages {
    readonly steering: readonly string[]
    readonly followUp: readonly string[]
}

type TSessionListener = () => void

/** Connects one live Agent to durable history and UI subscriptions. */
export class AgentSession {
    readonly agentId: string
    readonly id: string
    private readonly agent: Agent
    private readonly manager: ISessionManager
    private readonly listeners = new Set<TSessionListener>()
    private readonly unsubscribeAgent: () => void
    private readonly disposeTimeoutMs: number
    private readonly resolveRunConfiguration: TAgentRunConfigurationResolver
    private readonly now: () => number
    private readonly generateId: () => string
    private readonly autoCompactionThreshold: number
    private snapshot: ISessionSnapshot
    private disposed = false
    private disposeTask: Promise<void> | undefined
    private persistenceError: unknown
    private acceptCriticalEvents = true
    private compactionController: AbortController | undefined
    private compactionTask: Promise<ICompactionCheckpoint | undefined> | undefined

    constructor(options: IAgentSessionOptions) {
        this.agentId = options.agentId
        this.id = options.sessionId
        this.manager = options.manager
        this.resolveRunConfiguration = options.resolveRunConfiguration
        this.now = options.now ?? Date.now
        this.generateId = options.generateId ?? generateRandomId
        this.autoCompactionThreshold = options.autoCompactionThreshold
            ?? DEFAULT_AUTO_COMPACTION_THRESHOLD
        if (
            !Number.isFinite(this.autoCompactionThreshold)
            || this.autoCompactionThreshold <= 0
            || this.autoCompactionThreshold >= 1
        ) {
            throw new Error("autoCompactionThreshold must be between 0 and 1")
        }
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
            // Projekcja jest liczona dopiero przy nowym promptcie. Agent zachowuje
            // pełny stan dla UI/persistence, a model dostaje summary i nowszy ogon.
            projectContext: (messages) => projectAgentContext(
                messages,
                this.manager.getCompactionCheckpoint(this.id),
            ),
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
        if (this.compactionTask) {
            throw new Error("Cannot submit a prompt while compacting the session")
        }
        if (this.persistenceError !== undefined) {
            throw new Error(
                "Session persistence failed. Reopen the session before submitting another prompt.",
                { cause: this.persistenceError },
            )
        }
        return this.agent.prompt(text)
    }

    steer(text: string): void {
        if (this.disposed) throw new Error("AgentSession is disposed")
        if (this.persistenceError !== undefined) {
            throw new Error(
                "Session persistence failed. Reopen the session before submitting another prompt.",
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
                "Session persistence failed. Reopen the session before submitting another prompt.",
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

    resolveToolApproval(
        approvalId: string,
        decision: TToolApprovalDecision,
    ): void {
        if (this.disposed) throw new Error("AgentSession is disposed")
        this.agent.resolveToolApproval(approvalId, decision)
    }

    async abort(): Promise<void> {
        if (this.disposed) return
        const compactionController = this.compactionController
        compactionController?.abort("Buli interaction was aborted")
        await Promise.all([
            this.agent.abort(),
            this.compactionTask?.catch((error: unknown) => {
                if (!compactionController?.signal.aborted) throw error
            }),
        ])
    }

    async waitForIdle(): Promise<void> {
        // Auto-compaction może rozpocząć się w listenerze settlementu, dlatego
        // odczytujemy task dopiero po zakończeniu runu, a nie równolegle przed nim.
        await this.agent.waitForIdle()
        await this.compactionTask
    }

    compact(
        reason: ICompactionCheckpoint["reason"] = "manual",
    ): Promise<ICompactionCheckpoint | undefined> {
        if (this.disposed) throw new Error("AgentSession is disposed")
        if (this.persistenceError !== undefined) {
            throw new Error(
                "Session persistence failed. Reopen the session before compacting it.",
                { cause: this.persistenceError },
            )
        }
        if (this.agent.state.isRunning) {
            throw new Error("Cannot compact while AgentSession is running")
        }
        if (this.compactionTask) {
            throw new Error("AgentSession is already compacting")
        }

        const controller = new AbortController()
        this.compactionController = controller
        const previousCheckpoint = this.manager.getCompactionCheckpoint(this.id)
        const task = compactSessionMessages({
            sessionId: this.id,
            messages: this.manager.getMessages(this.id),
            ...(previousCheckpoint === undefined
                ? {}
                : { previousCheckpoint }),
            runConfiguration: this.resolveRunConfiguration(),
            reason,
            signal: controller.signal,
            now: this.now,
            generateId: this.generateId,
        }).then((checkpoint) => {
            if (checkpoint) this.manager.saveCompactionCheckpoint(checkpoint)
            return checkpoint
        }).finally(() => {
            if (this.compactionTask === task) {
                this.compactionTask = undefined
                this.compactionController = undefined
            }
        })
        this.compactionTask = task
        return task
    }

    dispose(): Promise<void> {
        this.disposeTask ??= this.disposeInternal()
        return this.disposeTask
    }

    private async disposeInternal(): Promise<void> {
        if (this.disposed) return
        this.disposed = true
        const compactionController = this.compactionController
        compactionController?.abort("AgentSession is shutting down")
        try {
            await withTimeout(
                Promise.all([
                    this.agent.abort(),
                    this.compactionTask?.catch((error: unknown) => {
                        if (!compactionController?.signal.aborted) throw error
                    }),
                ]).then(() => undefined),
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
        if (
            event.type === "agent_settled"
            && event.reason === "completed"
            && this.shouldCompactAutomatically()
        ) {
            // Auto-compaction nie opóźnia settlementu ukończonego runu. Nowy prompt
            // zostanie jednak odrzucony przez guard, dopóki checkpoint nie będzie trwały.
            void this.compact("automatic").catch((error: unknown) => {
                console.error("Automatic session compaction failed", error)
            })
        }
        this.publishSnapshot()
    }

    private shouldCompactAutomatically(): boolean {
        const latestAssistant = this.agent.state.messages.findLast(
            (message) => message.role === "assistant",
        )
        const contextWindow = latestAssistant?.model?.contextWindowTokens
        if (!contextWindow) return false

        const usage = latestAssistant.usage
        const usedTokens = usage?.totalTokens
            ?? ((usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0))
        return usedTokens >= contextWindow * this.autoCompactionThreshold
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
            ...(state.pendingToolApproval
                ? { pendingToolApproval: state.pendingToolApproval }
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
