import {
    Agent,
    type IAgentEvent,
    type IAgentModelRequest,
    type IAgentRunConfiguration,
    type IAgentRunHandle,
    type IAgentState,
    type IAgentTool,
    type TAgentMessage,
    type TAgentRunConfigurationResolver,
    type TToolApprovalDecision,
} from "@/agent"
import { generateRandomId } from "@/common/ids"
import type { ICompactionCheckpoint } from "@/sessions/compaction/checkpoint"
import {
    estimateContextUsage,
    type IContextUsage,
} from "@/sessions/compaction/context-budget"
import {
    createContextAwareModel,
} from "@/sessions/compaction/context-aware-model"
import { projectAgentContext } from "@/sessions/compaction/context-projector"
import { compactSessionMessages } from "@/sessions/compaction/session-compactor"
import { createInterruptedToolResults } from "@/sessions/recovery"
import type { ISessionManager } from "@/sessions/repository"
import {
    freezeSessionSnapshot,
    type ISessionSnapshot,
} from "@/sessions/snapshot"


const DEFAULT_DISPOSE_TIMEOUT_MS = 5_000

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
    private readonly systemPrompt: string
    private readonly tools: readonly IAgentTool[]
    private readonly now: () => number
    private readonly generateId: () => string
    private snapshot: ISessionSnapshot
    private contextUsage: IContextUsage | undefined
    private currentContextWindowTokens: number | undefined
    private contextUsageRefreshPending = false
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
        this.systemPrompt = options.systemPrompt
        this.tools = options.tools
        this.now = options.now ?? Date.now
        this.generateId = options.generateId ?? generateRandomId
        this.disposeTimeoutMs = options.disposeTimeoutMs ?? DEFAULT_DISPOSE_TIMEOUT_MS
        if (!Number.isFinite(this.disposeTimeoutMs) || this.disposeTimeoutMs <= 0) {
            throw new Error("disposeTimeoutMs must be a positive finite number")
        }
        const initialMessages = this.loadDurableHistory()
        this.initializeContextUsage(initialMessages)
        this.agent = new Agent({
            // agent for sessionId
            sessionId: options.sessionId,
            // it's system prompt
            systemPrompt: this.systemPrompt,
            resolveRunConfiguration: () =>
                this.resolveConversationRunConfiguration(),
            tools: this.tools,
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

    /** Recomputes derived context telemetry after an idle model/catalog change. */
    refreshContextUsage(): void {
        if (this.disposed) return
        if (this.agent.state.isRunning) {
            this.contextUsageRefreshPending = true
            return
        }
        this.refreshContextUsageFromRunConfiguration()
        this.publishSnapshot()
    }

    private refreshContextUsageFromRunConfiguration(): void {
        try {
            const runConfiguration = this.resolveRunConfiguration()
            this.currentContextWindowTokens =
                runConfiguration.modelProfile?.contextWindowTokens
        } catch {
            this.currentContextWindowTokens = undefined
        }
        this.updateContextUsageFromDurableHistory()
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
        if (this.compactionTask) {
            throw new Error("Cannot steer while compacting the session")
        }
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
        if (this.compactionTask) {
            throw new Error("Cannot queue a follow-up while compacting the session")
        }
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
        return this.startCompaction(reason)
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

    private resolveConversationRunConfiguration(): IAgentRunConfiguration {
        const runConfiguration = this.resolveRunConfiguration()
        const contextWindowTokens =
            runConfiguration.modelProfile?.contextWindowTokens
        this.currentContextWindowTokens = contextWindowTokens

        return {
            ...runConfiguration,
            model: createContextAwareModel({
                model: runConfiguration.model,
                contextWindowTokens,
                projectRequest: (request) => this.reprojectRequest(request),
                compactAndReproject: (request, requestBudgetTokens) =>
                    this.compactAndReproject(request, requestBudgetTokens),
                publishContextUsage: (usage) => {
                    if (this.disposed) return
                    this.contextUsage = structuredClone(usage)
                    this.publishSnapshot()
                },
            }),
        }
    }

    private async compactAndReproject(
        originalRequest: IAgentModelRequest,
        requestBudgetTokens: number,
    ): Promise<IAgentModelRequest | undefined> {
        const previousCount = this.manager.getCompactionCheckpoint(this.id)
            ?.compactedMessageCount ?? 0
        const checkpoint = await (this.compactionTask ?? this.startCompaction(
            "automatic",
            requestBudgetTokens,
            originalRequest.signal,
        ))
        if (
            !checkpoint
            || checkpoint.compactedMessageCount <= previousCount
        ) {
            return undefined
        }

        return this.reprojectRequest(originalRequest, checkpoint)
    }

    private reprojectRequest(
        originalRequest: IAgentModelRequest,
        checkpoint = this.manager.getCompactionCheckpoint(this.id),
    ): IAgentModelRequest {
        const projection = projectAgentContext(
            this.manager.getMessages(this.id),
            checkpoint,
        )
        const request = {
            ...originalRequest,
            messages: projection.messages,
        }
        if (projection.contextSummary === undefined) {
            delete request.contextSummary
            return request
        }
        return {
            ...request,
            contextSummary: projection.contextSummary,
        }
    }

    private startCompaction(
        reason: ICompactionCheckpoint["reason"],
        requestBudgetTokens?: number,
        sourceSignal?: AbortSignal,
    ): Promise<ICompactionCheckpoint | undefined> {
        if (this.disposed) throw new Error("AgentSession is disposed")
        if (this.persistenceError !== undefined) {
            throw new Error(
                "Session persistence failed. Reopen the session before compacting it.",
                { cause: this.persistenceError },
            )
        }
        if (this.compactionTask) return this.compactionTask

        const controller = new AbortController()
        const abortFromSource = () => controller.abort(sourceSignal?.reason)
        if (sourceSignal?.aborted) abortFromSource()
        else sourceSignal?.addEventListener("abort", abortFromSource, { once: true })

        this.compactionController = controller
        const operation = this.performCompaction(
            reason,
            requestBudgetTokens,
            controller,
        )
        const completed = operation.then(
            (checkpoint) => {
                this.publishSnapshot()
                return checkpoint
            },
            (error: unknown) => {
                this.publishSnapshot()
                throw error
            },
        )
        let task: Promise<ICompactionCheckpoint | undefined>
        task = completed.finally(() => {
            sourceSignal?.removeEventListener("abort", abortFromSource)
            if (this.compactionTask === task) {
                this.compactionTask = undefined
                this.compactionController = undefined
            }
            this.publishSnapshot()
        })
        this.compactionTask = task
        this.publishSnapshot()
        return task
    }

    private async performCompaction(
        reason: ICompactionCheckpoint["reason"],
        requestBudgetTokens: number | undefined,
        controller: AbortController,
    ): Promise<ICompactionCheckpoint | undefined> {
        const previousCheckpoint = this.manager.getCompactionCheckpoint(this.id)
        const runConfiguration = this.resolveRunConfiguration()
        if (!this.agent.state.isRunning) {
            this.currentContextWindowTokens =
                runConfiguration.modelProfile?.contextWindowTokens
        }
        const checkpoint = await compactSessionMessages({
            sessionId: this.id,
            messages: this.manager.getMessages(this.id),
            ...(previousCheckpoint === undefined
                ? {}
                : { previousCheckpoint }),
            runConfiguration,
            ...(requestBudgetTokens === undefined
                ? {}
                : { requestBudgetTokens }),
            reason,
            signal: controller.signal,
            now: this.now,
            generateId: this.generateId,
        })
        if (!checkpoint) return undefined

        controller.signal.throwIfAborted()
        try {
            this.manager.saveCompactionCheckpoint(checkpoint)
        } catch (error) {
            this.persistenceError = error
            throw error
        }
        this.updateContextUsageFromDurableHistory()
        return checkpoint
    }

    private initializeContextUsage(
        messages: readonly TAgentMessage[],
    ): void {
        try {
            const runConfiguration = this.resolveRunConfiguration()
            this.currentContextWindowTokens =
                runConfiguration.modelProfile?.contextWindowTokens
        } catch {
            this.currentContextWindowTokens = undefined
        }
        this.contextUsage = this.estimateProjectedContext(messages)
    }

    private updateContextUsageFromDurableHistory(): void {
        this.contextUsage = this.estimateProjectedContext(
            this.manager.getMessages(this.id),
        )
    }

    private estimateProjectedContext(
        messages: readonly TAgentMessage[],
    ): IContextUsage {
        const projection = projectAgentContext(
            messages,
            this.manager.getCompactionCheckpoint(this.id),
        )
        return estimateContextUsage({
            systemPrompt: this.systemPrompt,
            ...(projection.contextSummary === undefined
                ? {}
                : { contextSummary: projection.contextSummary }),
            messages: projection.messages,
            tools: this.tools,
        }, this.currentContextWindowTokens)
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
        if (event.type === "message_end") {
            this.updateContextUsageFromDurableHistory()
        }
        if (event.type === "agent_settled" && this.contextUsageRefreshPending) {
            this.contextUsageRefreshPending = false
            this.refreshContextUsageFromRunConfiguration()
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
        if (this.disposed) return
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
            isCompacting: this.compactionTask !== undefined,
            ...(this.contextUsage === undefined
                ? {}
                : { contextUsage: this.contextUsage }),
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
