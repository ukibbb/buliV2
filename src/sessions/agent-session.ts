import {
    Agent,
    ToolPolicy,
    isToolAllowed,
    type TAgentEvent,
    type IAgentModelRequest,
    type IAgentContextProjection,
    type IAgentRunConfiguration,
    type IAgentRunHandle,
    type IAgentState,
    type IRuntimeAgentTool,
    type IAgentToolContext,
    type IToolOutputStore,
    type IModelProfile,
    type TUserInput,
    type IUserInputContent,
} from "@/agent"
import { generateRandomId } from "@/common/ids"
import { MAIN_BRANCH_ID } from "@/sessions/branches"
import type { ICompactionCheckpoint } from "@/sessions/compaction/checkpoint"
import {
    estimateContextUsage,
    estimateCompactionProgressInputTokens,
    type IContextUsage,
    type IContextEstimationPolicy,
} from "@/sessions/compaction/context-budget"
import {
    createContextAwareModel,
} from "@/sessions/compaction/context-aware-model"
import {
    projectCompactionCandidate,
} from "@/sessions/compaction/context-projector"
import {
    compactSessionMessages,
    type ICompactionProgress,
} from "@/sessions/compaction/session-compactor"
import { AgentWorkingContext } from "@/sessions/agent-working-context"
import type { IHistoryCursor, IHistoryPage } from "@/sessions/history-contracts"
import type { ISessionManager } from "@/sessions/repository"
import {
    freezeSessionSnapshot,
    type ISessionSnapshotFreezeCache,
    type ISessionSnapshot,
} from "@/sessions/snapshot"
const DEFAULT_DISPOSE_TIMEOUT_MS = 5_000

function restoredErrorOptions(context: IAgentContextProjection): { initialAssistantError?: NonNullable<IAgentState["assistantError"]> } {
    const last = context.messages.at(-1)
    if (last?.role !== "assistant" || !last.errorMessage) return {}
    return { initialAssistantError: { id: last.id, runId: last.runId, errorMessage: last.errorMessage } }
}

export interface IAgentSessionRunConfiguration extends IAgentRunConfiguration {
    readonly estimationPolicy?: IContextEstimationPolicy
}

type TSessionRunConfigurationResolver = () => IAgentSessionRunConfiguration

interface IAgentSessionOptions {
    readonly agentId: string
    readonly sessionId: string
    readonly manager: ISessionManager
    readonly systemPrompt: string
    readonly resolveRunConfiguration: TSessionRunConfigurationResolver
    readonly tools: readonly IRuntimeAgentTool[]
    readonly now?: () => number
    readonly generateId?: () => string
    readonly disposeTimeoutMs?: number
    readonly toolOutputStore?: IToolOutputStore
}

export interface ISessionConfiguration {
    readonly agentId?: string
    readonly activeMcpServerIds?: readonly string[]
    readonly systemPrompt: string
    readonly tools: readonly IRuntimeAgentTool[]
}

interface IQueuedSessionMessages {
    readonly steering: readonly TUserInput[]
    readonly followUp: readonly TUserInput[]
}

type TSessionListener = () => void

/** Connects one live Agent to durable history and UI subscriptions. */
export class AgentSession {
    private currentAgentId: string
    get agentId(): string { return this.currentAgentId }
    readonly id: string
    private readonly agent: Agent
    private readonly manager: ISessionManager
    private activeBranchId: string
    private readonly workingContext: AgentWorkingContext
    private readonly historyListeners = new Set<TSessionListener>()
    private readonly listeners = new Set<TSessionListener>()
    private readonly unsubscribeAgent: () => void
    private readonly disposeTimeoutMs: number
    private readonly resolveRunConfiguration: TSessionRunConfigurationResolver
    private systemPrompt: string
    private mcpStatusCache: {
        tools: readonly IRuntimeAgentTool[]
        serverIds: readonly string[]
        value: NonNullable<ISessionSnapshot["activeMcpServers"]>
    } | undefined
    private activeMcpServerIds: readonly string[] = []
    private availableTools: readonly IRuntimeAgentTool[]
    private tools: readonly IRuntimeAgentTool[]
    private branchSwitchInProgress = false
    private branchSwitchError: Error | undefined
    private readonly now: () => number
    private readonly generateId: () => string
    private readonly snapshotFreezeCache: ISessionSnapshotFreezeCache = {
        source: undefined,
        value: undefined,
    }
    private pendingToolCallIdsSource: ReadonlySet<string> | undefined
    private pendingToolCallIdsSnapshot: readonly string[] = []
    private queuedMessagesRevision: number | undefined
    private queuedMessagesSource: Pick<
        ISessionSnapshot, "pendingSteeringMessages" | "pendingFollowUpMessages"
    > | undefined
    private snapshot: ISessionSnapshot
    private contextUsage: IContextUsage | undefined
    private currentContextWindowTokens: number | undefined
    private activeBaseConfiguration: IAgentSessionRunConfiguration | undefined
    private currentModelProfile: IModelProfile | undefined
    private currentEstimationPolicy: IContextEstimationPolicy | undefined
    private contextUsageRefreshPending = false
    private disposed = false
    private disposeTask: Promise<void> | undefined
    private persistenceError: { readonly cause: unknown } | undefined
    private acceptCriticalEvents = true
    private compactionController: AbortController | undefined
    private compactionProgress: ICompactionProgress | undefined
    private compactionTask: Promise<ICompactionCheckpoint | undefined> | undefined

    constructor(options: IAgentSessionOptions) {
        this.currentAgentId = options.agentId
        this.id = options.sessionId
        this.manager = options.manager
        this.activeBranchId = this.manager.getActiveBranchId(this.id)
        this.resolveRunConfiguration = options.resolveRunConfiguration
        this.systemPrompt = options.systemPrompt
        this.availableTools = [...options.tools]
        this.tools = this.resolveActiveTools()
        this.now = options.now ?? Date.now
        this.generateId = options.generateId ?? generateRandomId
        this.disposeTimeoutMs = options.disposeTimeoutMs ?? DEFAULT_DISPOSE_TIMEOUT_MS
        if (!Number.isFinite(this.disposeTimeoutMs) || this.disposeTimeoutMs <= 0) {
            throw new Error("disposeTimeoutMs must be a positive finite number")
        }
        this.manager.recoverInterruptedTools(this.id)
        this.workingContext = new AgentWorkingContext(this.manager.loadRequiredContext(this.id))
        this.initializeContextUsage()
        this.agent = new Agent({
            // agent for sessionId
            sessionId: options.sessionId,
            // it's system prompt
            systemPrompt: this.systemPrompt,
            resolveRunConfiguration: () =>
                this.resolveConversationRunConfiguration(),
            tools: this.tools,
            ...restoredErrorOptions(this.workingContext.getContext()),
            ...(options.toolOutputStore === undefined
                ? {}
                : { toolOutputStore: options.toolOutputStore }),
            criticalEventSink: (event) => {
                if (!this.acceptCriticalEvents) {
                    throw new Error("AgentSession stopped accepting events during shutdown")
                }
                if (event.type === "message_end") {
                    try {
                        const result = this.manager.appendMessage(event.message)
                        if (result.kind === "inserted") {
                            this.workingContext.acceptCommittedMessage(event.message)
                        } else {
                            this.workingContext.replaceContext(this.manager.loadRequiredContext(this.id))
                        }
                    } catch (error) {
                        this.persistenceError = { cause: error }
                        throw error
                    }
                }
            },
            onObserverError: (error) => {
                console.error("Agent observer failed", error)
            },
            getContext: this.workingContext.getContext,
            getSelectedPathReferences: () => this.manager.loadSelectedPaths(this.id),
            getRecentConversation: () => this.manager.loadRecentConversation(this.id),
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

    readonly loadHistoryPage = (branchId: string, cursor?: IHistoryCursor): IHistoryPage => {
        if (this.disposed) throw new Error("AgentSession is disposed")
        return this.manager.loadHistoryPage(this.id, branchId, cursor)
    }

    readonly subscribeHistory = (listener: TSessionListener): (() => void) => {
        if (this.disposed) return () => {}
        this.historyListeners.add(listener)
        return () => this.historyListeners.delete(listener)
    }

    readonly subscribe = (listener: TSessionListener): (() => void) => {
        if (this.disposed) return () => {}
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
    }

    createBranch(): string {
        this.assertCanSwitchBranch()
        const branchId = this.generateId()
        this.switchBranch(() => this.manager.createBranch(this.id, branchId))
        return branchId
    }

    returnToParentBranch(): void {
        this.assertCanSwitchBranch()
        if (this.activeBranchId === MAIN_BRANCH_ID) {
            throw new Error("Cannot return from the main branch")
        }
        this.switchBranch(() => this.manager.returnToParentBranch(this.id))
    }

    /** Applies complete model configuration without replacing conversation history. */
    updateConfiguration(configuration: ISessionConfiguration): void {
        this.assertCanUpdateConfiguration()
        const availableTools = [...configuration.tools]
        this.assertUniqueToolNames(availableTools)
        const tools = this.resolveActiveTools(availableTools)
        const nextConfiguration = {
            systemPrompt: configuration.systemPrompt,
            tools,
        }
        const nextContextUsage = this.estimateProjectedContext(nextConfiguration)
        const activeMcpServerIds = [...(configuration.activeMcpServerIds ?? [])]
        const nextSnapshot = this.createSnapshot(nextContextUsage, tools, activeMcpServerIds)

        if (configuration.agentId !== undefined && configuration.agentId !== this.agentId) {
            this.manager.updateSessionAgent(this.id, configuration.agentId)
            this.currentAgentId = configuration.agentId
        }
        this.agent.updateConfiguration(nextConfiguration)
        this.systemPrompt = nextConfiguration.systemPrompt
        this.availableTools = availableTools
        this.activeMcpServerIds = activeMcpServerIds
        this.tools = tools
        this.contextUsage = nextContextUsage
        this.snapshot = nextSnapshot
        this.notifyListeners()
    }

    /** Host-side authorization for an externally supplied tool executor. */
    assertToolExecutionAllowed(tool: IRuntimeAgentTool, context: IAgentToolContext): void {
        if (this.disposed) throw new Error("AgentSession is disposed")
        if (context.sessionId !== this.id) {
            throw new Error("Tool execution belongs to another session")
        }
        this.assertBranchContextAvailable()
        const policy = this.activeBranchId === MAIN_BRANCH_ID
            ? ToolPolicy.Full
            : ToolPolicy.ReadOnly
        if (!isToolAllowed(tool, policy)) {
            throw new Error(`Tool "${tool.name}" is not allowed on this branch`)
        }
        context.signal.throwIfAborted()
    }

    private assertUniqueToolNames(tools: readonly IRuntimeAgentTool[]): void {
        const names = new Set<string>()
        for (const tool of tools) {
            if (names.has(tool.name)) throw new Error(`Duplicate tool name: ${tool.name}`)
            names.add(tool.name)
        }
    }

    /** Checks readiness before asynchronous configuration preparation; application rechecks on commit. */
    assertCanUpdateConfiguration(): void {
        if (this.disposed) throw new Error("AgentSession is disposed")
        this.assertBranchContextAvailable()
        if (this.persistenceError !== undefined) {
            throw new Error("Session persistence failed. Reopen the session before updating configuration.")
        }
        if (this.agent.state.isRunning || this.agent.state.pendingToolCallIds.size > 0) {
            throw new Error("Cannot update configuration while AgentSession is running")
        }
        if (this.compactionTask) throw new Error("Cannot update configuration while compacting")
        if (this.agent.pendingSteeringMessages.length > 0 || this.agent.pendingFollowUpMessages.length > 0) {
            throw new Error("Restore queued messages before updating configuration")
        }
    }

    private resolveActiveTools(
        availableTools: readonly IRuntimeAgentTool[] = this.availableTools,
    ): readonly IRuntimeAgentTool[] {
        const policy = this.activeBranchId === MAIN_BRANCH_ID
            ? ToolPolicy.Full
            : ToolPolicy.ReadOnly
        return availableTools.filter((tool) => isToolAllowed(tool, policy))
    }

    private assertBranchContextAvailable(): void {
        if (this.branchSwitchError) throw this.branchSwitchError
        if (this.branchSwitchInProgress) {
            throw new Error("Cannot interact while switching branches")
        }
    }

    private assertCanSwitchBranch(): void {
        if (this.disposed) throw new Error("AgentSession is disposed")
        this.assertBranchContextAvailable()
        if (this.persistenceError !== undefined) {
            throw new Error("Session persistence failed. Reopen the session before switching branches.", {
                cause: this.persistenceError.cause,
            })
        }
        if (this.agent.state.isRunning || this.agent.state.pendingToolCallIds.size > 0) {
            throw new Error("Cannot switch branches while AgentSession is running")
        }
        if (this.compactionTask) throw new Error("Cannot switch branches while compacting")
        if (this.agent.pendingSteeringMessages.length > 0 || this.agent.pendingFollowUpMessages.length > 0) {
            throw new Error("Restore queued messages before switching branches")
        }
    }

    private switchBranch(navigate: () => void): void {
        this.assertCanSwitchBranch()
        this.branchSwitchInProgress = true
        try {
            navigate()
            this.activeBranchId = this.manager.getActiveBranchId(this.id)
            this.manager.recoverInterruptedTools(this.id)
            const context = this.manager.loadRequiredContext(this.id)
            const tools = this.resolveActiveTools()
            this.workingContext.replaceContext(context)
            this.agent.replaceContext(tools, restoredErrorOptions(context).initialAssistantError)
            this.tools = tools
            this.updateContextUsageFromWorkingContext()
            this.publishSnapshot()
        } catch (cause) {
            this.branchSwitchError = new Error(
                "Branch switching failed. Reopen the session before continuing.",
                { cause },
            )
            throw this.branchSwitchError
        } finally {
            this.branchSwitchInProgress = false
        }
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
            this.setCurrentContextConfiguration(this.captureRunConfiguration())
        } catch {
            this.currentContextWindowTokens = undefined
            this.currentModelProfile = undefined
            this.currentEstimationPolicy = undefined
        }
        this.updateContextUsageFromWorkingContext()
    }

    prompt(input: TUserInput): IAgentRunHandle {
        this.assertBranchContextAvailable()
        if (this.disposed) throw new Error("AgentSession is disposed")
        if (this.compactionTask) {
            throw new Error("Cannot submit a prompt while compacting the session")
        }
        if (this.persistenceError !== undefined) {
            throw new Error(
                "Session persistence failed. Reopen the session before submitting another prompt.",
                { cause: this.persistenceError.cause },
            )
        }
        return this.agent.prompt(input)
    }

    steer(input: TUserInput): void {
        this.assertBranchContextAvailable()
        if (this.disposed) throw new Error("AgentSession is disposed")
        if (this.compactionTask) {
            throw new Error("Cannot steer while compacting the session")
        }
        if (this.persistenceError !== undefined) {
            throw new Error(
                "Session persistence failed. Reopen the session before submitting another prompt.",
                { cause: this.persistenceError.cause },
            )
        }
        this.agent.steer(input)
        this.publishSnapshot()
    }

    followUp(input: TUserInput): void {
        this.assertBranchContextAvailable()
        if (this.disposed) throw new Error("AgentSession is disposed")
        if (this.compactionTask) {
            throw new Error("Cannot queue a follow-up while compacting the session")
        }
        if (this.persistenceError !== undefined) {
            throw new Error(
                "Session persistence failed. Reopen the session before submitting another prompt.",
                { cause: this.persistenceError.cause },
            )
        }
        this.agent.followUp(input)
        this.publishSnapshot()
    }

    clearQueuedMessages(): IQueuedSessionMessages {
        if (this.disposed) throw new Error("AgentSession is disposed")
        const messages = this.agent.clearQueuedMessages()
        if (messages.steering.length > 0 || messages.followUp.length > 0) {
            this.publishSnapshot()
        }
        return {
            steering: messages.steering.map(userMessageInput),
            followUp: messages.followUp.map(userMessageInput),
        }
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
        this.assertBranchContextAvailable()
        if (this.disposed) throw new Error("AgentSession is disposed")
        if (this.persistenceError !== undefined) {
            throw new Error(
                "Session persistence failed. Reopen the session before compacting it.",
                { cause: this.persistenceError.cause },
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
            this.historyListeners.clear()
        }
    }

    private captureRunConfiguration(): IAgentSessionRunConfiguration {
        const configuration = this.resolveRunConfiguration()
        return {
            ...configuration,
            ...(configuration.modelProfile === undefined ? {} : {
                modelProfile: structuredClone(configuration.modelProfile),
            }),
            ...(configuration.estimationPolicy === undefined ? {} : {
                estimationPolicy: { ...configuration.estimationPolicy },
            }),
        }
    }

    assertPersistenceAvailable(): void {
        if (this.persistenceError) throw this.persistenceError.cause
    }

    getActiveRunConfiguration(runId: string): IAgentSessionRunConfiguration {
        if (!this.state.isRunning || this.state.activeRunId !== runId || !this.activeBaseConfiguration) {
            throw new Error("Parent execution is not active")
        }
        return { ...this.activeBaseConfiguration }
    }

    private resolveConversationRunConfiguration(): IAgentRunConfiguration {
        const runConfiguration = this.captureRunConfiguration()
        this.activeBaseConfiguration = runConfiguration
        const contextWindowTokens =
            runConfiguration.modelProfile?.contextWindowTokens
        this.setCurrentContextConfiguration(runConfiguration)

        return {
            ...runConfiguration,
            model: createContextAwareModel({
                model: runConfiguration.model,
                ...(runConfiguration.modelProfile === undefined
                    ? {}
                    : { modelProfile: runConfiguration.modelProfile }),
                contextWindowTokens,
                ...(runConfiguration.estimationPolicy === undefined ? {} : {
                    estimationPolicy: runConfiguration.estimationPolicy,
                }),
                projectRequest: (request) => this.reprojectRequest(request),
                compactAndReproject: (request) =>
                    this.compactAndReproject(request, runConfiguration),
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
        runConfiguration: IAgentSessionRunConfiguration,
    ): Promise<IAgentModelRequest | undefined> {
        const checkpoint = await (this.compactionTask ?? this.startCompaction(
            "automatic",
            originalRequest.signal,
            originalRequest,
            runConfiguration,
        ))
        if (!checkpoint) return undefined

        return this.reprojectRequest(originalRequest)
    }

    private reprojectRequest(originalRequest: IAgentModelRequest): IAgentModelRequest {
        const projection = this.workingContext.getContext()
        return requestWithContext(originalRequest, projection)
    }

    private startCompaction(
        reason: ICompactionCheckpoint["reason"],
        sourceSignal?: AbortSignal,
        originalRequest?: IAgentModelRequest,
        activeRunConfiguration?: IAgentSessionRunConfiguration,
    ): Promise<ICompactionCheckpoint | undefined> {
        this.assertBranchContextAvailable()
        if (this.disposed) throw new Error("AgentSession is disposed")
        if (this.persistenceError !== undefined) {
            throw new Error(
                "Session persistence failed. Reopen the session before compacting it.",
                { cause: this.persistenceError.cause },
            )
        }
        if (this.compactionTask) return this.compactionTask

        const controller = new AbortController()
        const abortFromSource = () => controller.abort(sourceSignal?.reason)
        if (sourceSignal?.aborted) abortFromSource()
        else sourceSignal?.addEventListener("abort", abortFromSource, { once: true })

        this.compactionController = controller
        const clearProgressOnAbort = () => {
            if (this.compactionController !== controller || !this.compactionProgress) return
            this.compactionProgress = undefined
            this.publishSnapshot()
        }
        controller.signal.addEventListener("abort", clearProgressOnAbort, { once: true })
        const operation = this.performCompaction(
            reason,
            controller,
            originalRequest,
            activeRunConfiguration,
        )
        let task: Promise<ICompactionCheckpoint | undefined>
        task = operation.finally(() => {
            sourceSignal?.removeEventListener("abort", abortFromSource)
            controller.signal.removeEventListener("abort", clearProgressOnAbort)
            if (this.compactionTask === task) {
                this.compactionTask = undefined
                this.compactionController = undefined
                this.compactionProgress = undefined
            }
            this.publishSnapshot()
        })
        this.compactionTask = task
        this.publishSnapshot()
        return task
    }

    private async performCompaction(
        reason: ICompactionCheckpoint["reason"],
        controller: AbortController,
        originalRequest?: IAgentModelRequest,
        activeRunConfiguration?: IAgentSessionRunConfiguration,
    ): Promise<ICompactionCheckpoint | undefined> {
        const runConfiguration = activeRunConfiguration
            ?? this.captureRunConfiguration()
        if (!this.agent.state.isRunning) {
            this.setCurrentContextConfiguration(runConfiguration)
        }
        const context = this.workingContext.getContext()
        const checkpoint = await compactSessionMessages({
            sessionId: this.id,
            context,
            runConfiguration,
            ...(originalRequest === undefined
                ? {}
                : { allowSummaryRecompression: true }),
            reason,
            signal: controller.signal,
            now: this.now,
            generateId: this.generateId,
            onProgress: (progress) => {
                if (
                    this.disposed
                    || controller.signal.aborted
                    || this.compactionController !== controller
                ) return
                this.compactionProgress = progress
                this.publishSnapshot()
            },
        })
        if (!checkpoint) return undefined

        const candidate = projectCompactionCandidate(context, checkpoint)
        const estimate = (projection: IAgentContextProjection) => originalRequest === undefined
            ? estimatedProjectionInputTokens(
                this.systemPrompt,
                this.tools,
                projection,
                runConfiguration.modelProfile,
                runConfiguration.estimationPolicy,
            )
            : estimatedRequestInputTokens(
                requestWithContext(originalRequest, projection),
                runConfiguration.modelProfile,
                runConfiguration.estimationPolicy,
            )
        const beforeTokens = estimate(context)
        const afterTokens = estimate(candidate)
        if (afterTokens >= beforeTokens) {
            return undefined
        }

        controller.signal.throwIfAborted()
        try {
            this.manager.saveCompactionCheckpoint(checkpoint)
            this.workingContext.replaceContext(this.manager.loadRequiredContext(this.id))
        } catch (error) {
            this.persistenceError = { cause: error }
            throw error
        }
        this.updateContextUsageFromWorkingContext()
        this.notifyHistoryListeners()
        return checkpoint
    }

    private initializeContextUsage(): void {
        try {
            this.setCurrentContextConfiguration(this.captureRunConfiguration())
        } catch {
            this.currentContextWindowTokens = undefined
            this.currentModelProfile = undefined
            this.currentEstimationPolicy = undefined
        }
        this.contextUsage = this.estimateProjectedContext()
    }

    private updateContextUsageFromWorkingContext(): void {
        this.contextUsage = this.estimateProjectedContext()
    }

    private estimateProjectedContext(
        configuration: ISessionConfiguration = {
            systemPrompt: this.systemPrompt,
            tools: this.tools,
        },
    ): IContextUsage {
        const projection = this.workingContext.getContext()
        return estimateContextUsage({
            systemPrompt: configuration.systemPrompt,
            ...(projection.contextSummary === undefined
                ? {}
                : { contextSummary: projection.contextSummary }),
            messages: projection.messages,
            tools: configuration.tools,
            ...(this.currentModelProfile === undefined
                ? {}
                : { modelProfile: this.currentModelProfile }),
            ...(this.currentEstimationPolicy === undefined ? {} : {
                estimationPolicy: this.currentEstimationPolicy,
            }),
        }, this.currentContextWindowTokens)
    }

    private setCurrentContextConfiguration(configuration: IAgentSessionRunConfiguration): void {
        const { modelProfile, estimationPolicy } = configuration
        this.currentEstimationPolicy = estimationPolicy === undefined
            ? undefined
            : { ...estimationPolicy }
        this.currentModelProfile = modelProfile === undefined
            ? undefined
            : structuredClone(modelProfile)
        this.currentContextWindowTokens = modelProfile?.contextWindowTokens
    }

    private handleAgentEvent(event: TAgentEvent): void {
        if (event.type === "message_end") {
            this.notifyHistoryListeners()
        }
        if (event.type === "agent_settled") {
            if (event.reason === "internal-error") {
                // Presentation can retry a read; it never clears the acceptance barrier.
                this.notifyHistoryListeners()
            }
            if (this.contextUsageRefreshPending) {
                this.contextUsageRefreshPending = false
                this.refreshContextUsageFromRunConfiguration()
            } else {
                this.updateContextUsageFromWorkingContext()
            }
        }
        this.publishSnapshot()
    }

    private notifyHistoryListeners(): void {
        if (this.disposed) return
        for (const listener of [...this.historyListeners]) {
            try { listener() } catch (error) { console.error("History observer failed", error) }
        }
    }

    private publishSnapshot(): void {
        this.snapshot = this.createSnapshot()
        this.notifyListeners()
    }

    private notifyListeners(): void {
        if (this.disposed) return
        for (const listener of [...this.listeners]) {
            try {
                listener()
            } catch (error) {
                console.error("Session observer failed", error)
            }
        }
    }

    private createSnapshot(
        contextUsage: IContextUsage | undefined = this.contextUsage,
        tools: readonly IRuntimeAgentTool[] = this.tools,
        activeMcpServerIds: readonly string[] = this.activeMcpServerIds,
    ): ISessionSnapshot {
        const state = this.agent.state

        // Queue consumption/restoration happens inside the Agent loop, not only in
        // steer()/followUp(). Its mutation token covers all those paths while the
        // freezer keeps older published snapshots detached and deeply immutable.
        const queuedMessagesRevision = this.agent.queuedMessagesRevision
        if (this.queuedMessagesSource === undefined || queuedMessagesRevision !== this.queuedMessagesRevision) {
            this.queuedMessagesSource = {
                pendingSteeringMessages: this.agent.pendingSteeringMessages,
                pendingFollowUpMessages: this.agent.pendingFollowUpMessages,
            }
            this.queuedMessagesRevision = queuedMessagesRevision
        }

        return freezeSessionSnapshot({
            activeBranchId: this.activeBranchId,
            ...(activeMcpServerIds.length === 0 ? {} : {
                activeMcpServers: this.snapshotMcpServers(tools, activeMcpServerIds),
            }),
            ...(state.assistantError === undefined ? {} : { assistantError: state.assistantError }),
            ...this.queuedMessagesSource,
            ...(state.streamingMessage
                ? { streamingMessage: state.streamingMessage }
                : {}),
            ...(this.compactionProgress === undefined
                ? {}
                : { compactionProgress: this.compactionProgress }),
            isRunning: state.isRunning,
            isCompacting: this.compactionTask !== undefined,
            ...(contextUsage === undefined
                ? {}
                : { contextUsage }),
            ...(state.activeRunId ? { activeRunId: state.activeRunId } : {}),
            pendingToolCallIds: this.snapshotPendingToolCallIds(
                state.pendingToolCallIds,
            ),
            ...(state.lastRunReason ? { lastRunReason: state.lastRunReason } : {}),
            ...(state.errorMessage ? { errorMessage: state.errorMessage } : {}),
        }, this.snapshotFreezeCache)
    }

    private snapshotMcpServers(tools: readonly IRuntimeAgentTool[], serverIds: readonly string[]) {
        if (this.mcpStatusCache?.tools === tools && this.mcpStatusCache.serverIds === serverIds) {
            return this.mcpStatusCache.value
        }
        const value = serverIds.map((serverId) => ({
            serverId,
            toolNames: tools.flatMap((tool) => {
                const binding = tool.sourceBinding
                return binding?.source.kind === "mcp" && binding.source.serverId === serverId
                    ? [binding.toolName] : []
            }),
        }))
        this.mcpStatusCache = { tools, serverIds, value }
        return value
    }

    private snapshotPendingToolCallIds(
        source: ReadonlySet<string>,
    ): readonly string[] {
        if (source !== this.pendingToolCallIdsSource) {
            // The reducer replaces this Set only when tool execution changes.
            this.pendingToolCallIdsSource = source
            this.pendingToolCallIdsSnapshot = [...source]
        }
        return this.pendingToolCallIdsSnapshot
    }
}

function estimatedRequestInputTokens(
    request: IAgentModelRequest,
    modelProfile?: IModelProfile,
    estimationPolicy?: IContextEstimationPolicy,
): number {
    return estimateCompactionProgressInputTokens({
        systemPrompt: request.systemPrompt,
        ...(request.contextSummary === undefined
            ? {}
            : { contextSummary: request.contextSummary }),
        messages: request.messages,
        tools: request.tools,
        ...(modelProfile === undefined ? {} : { modelProfile }),
        ...(estimationPolicy === undefined ? {} : { estimationPolicy }),
    })
}

function requestWithContext(
    originalRequest: IAgentModelRequest,
    projection: IAgentContextProjection,
): IAgentModelRequest {
    const request = { ...originalRequest, messages: projection.messages }
    if (projection.contextSummary === undefined) {
        delete request.contextSummary
    } else {
        request.contextSummary = projection.contextSummary
    }
    return request
}

function estimatedProjectionInputTokens(
    systemPrompt: string,
    tools: readonly IRuntimeAgentTool[],
    projection: IAgentContextProjection,
    modelProfile?: IModelProfile,
    estimationPolicy?: IContextEstimationPolicy,
): number {
    return estimateCompactionProgressInputTokens({
        systemPrompt,
        ...(projection.contextSummary === undefined
            ? {}
            : { contextSummary: projection.contextSummary }),
        messages: projection.messages,
        tools,
        ...(modelProfile === undefined ? {} : { modelProfile }),
        ...(estimationPolicy === undefined ? {} : { estimationPolicy }),
    })
}

function userMessageInput(message: {
    readonly content: string
    readonly references?: IUserInputContent["references"]
    readonly attachments?: IUserInputContent["attachments"]
}): TUserInput {
    if (!message.references?.length && !message.attachments?.length) {
        return message.content
    }
    return {
        text: message.content,
        ...(message.references?.length
            ? { references: structuredClone(message.references) }
            : {}),
        ...(message.attachments?.length
            ? { attachments: structuredClone(message.attachments) }
            : {}),
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
