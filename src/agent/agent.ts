import { runAgentLoop } from "@/agent/agent-loop"
import type {
    IAgentEvent,
    TAgentEventListener,
    TAgentCriticalEventSink,
} from "@/agent/events"
import type {
    IAgentRunConfiguration,
    TAgentRunConfigurationResolver,
} from "@/agent/model"
import type {
    IUserMessage,
    TAgentMessage,
    TUserMessageSource,
} from "@/agent/messages"
import type {
    IAgentRunHandle,
    IAgentState,
    TAgentContextProjector,
    TAgentRunEndReason,
} from "@/agent/state"
import { reduceAgentState } from "@/agent/state-reducer"
import type { IAgentTool } from "@/agent/tool"
import {
    assertToolApprovalDecision,
    createToolApprovalRequest,
    toolApprovalAbortMessage,
    type TToolApprovalDecision,
    type TToolApprovalDraft,
    type TToolApprovalRequest,
} from "@/agent/tool-approval"
import { generateRandomId } from "@/common/ids"

interface IAgentOptions {
    readonly sessionId: string
    readonly systemPrompt: string
    readonly resolveRunConfiguration: TAgentRunConfigurationResolver
    readonly tools: readonly IAgentTool[]
    readonly initialMessages?: readonly TAgentMessage[]
    readonly projectContext?: TAgentContextProjector
    readonly criticalEventSink?: TAgentCriticalEventSink
    readonly onObserverError?: (error: unknown) => void
    readonly now?: () => number
    readonly generateId?: () => string
}

interface IActiveAgentRun {
    readonly runId: string
    readonly promptId: string
    readonly abortController: AbortController
    readonly accepted: Promise<void>
    readonly resolveAccepted: () => void
    readonly rejectAccepted: (reason?: unknown) => void
    readonly settled: Promise<void>
    readonly resolveSettled: () => void
    readonly rejectSettled: (reason?: unknown) => void
    acceptedCompleted: boolean
    acceptingQueuedInput: boolean
}

interface IQueuedAgentMessages {
    readonly steering: readonly IUserMessage[]
    readonly followUp: readonly IUserMessage[]
}

interface IPendingToolApproval {
    readonly activeRun: IActiveAgentRun
    readonly request: TToolApprovalRequest
    readonly resolve: (decision: TToolApprovalDecision) => void
    readonly reject: (reason?: unknown) => void
}

/** Public facade owning one session's live state, queued input, and active run. */
export class Agent {
    private stateValue: IAgentState
    private readonly resolveRunConfiguration: TAgentRunConfigurationResolver
    private readonly criticalEventSink: TAgentCriticalEventSink | undefined
    private readonly onObserverError: ((error: unknown) => void) | undefined
    private readonly listeners = new Set<TAgentEventListener>()
    private readonly now: () => number
    private readonly generateId: () => string
    private readonly projectContext: TAgentContextProjector | undefined
    private steeringQueue: IUserMessage[] = []
    private followUpQueue: IUserMessage[] = []
    private activeRun: IActiveAgentRun | undefined
    private pendingToolApproval: IPendingToolApproval | undefined
    private readonly issuedToolApprovalIds = new Set<string>()

    constructor(options: IAgentOptions) {
        this.resolveRunConfiguration = options.resolveRunConfiguration
        this.criticalEventSink = options.criticalEventSink
        this.onObserverError = options.onObserverError
        this.now = options.now ?? Date.now
        this.generateId = options.generateId ?? generateRandomId
        this.projectContext = options.projectContext
        this.stateValue = {
            sessionId: options.sessionId,
            systemPrompt: options.systemPrompt,
            tools: [...options.tools],
            messages: structuredClone(options.initialMessages ?? []),
            isRunning: false,
            activeRunId: undefined,
            streamingMessage: undefined,
            pendingToolCallIds: new Set(),
            pendingToolApproval: undefined,
            errorMessage: undefined,
            lastRunReason: undefined,
        }
    }

    get state(): IAgentState {
        return this.stateValue
    }

    get pendingSteeringMessages(): readonly IUserMessage[] {
        return structuredClone(this.steeringQueue)
    }

    get pendingFollowUpMessages(): readonly IUserMessage[] {
        return structuredClone(this.followUpQueue)
    }

    subscribe(listener: TAgentEventListener): () => void {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
    }

    prompt(text: string): IAgentRunHandle {
        if (!text.trim()) throw new Error("Prompt cannot be empty")
        if (this.activeRun) {
            throw new Error("Agent is already processing a prompt")
        }
        if (this.steeringQueue.length > 0 || this.followUpQueue.length > 0) {
            throw new Error(
                "Restore queued messages before starting another prompt",
            )
        }

        const runConfiguration: IAgentRunConfiguration = this.resolveRunConfiguration()
        const context = this.projectContext?.(this.stateValue.messages) ?? {
            messages: this.stateValue.messages,
        }
        const runId = this.generateId()
        const prompt = this.createUserMessage(text, runId, "prompt")
        const abortController = new AbortController()
        const accepted = Promise.withResolvers<void>()
        const settled = Promise.withResolvers<void>()
        // Consumers may intentionally observe only one phase of the run.
        void accepted.promise.catch(() => { })
        void settled.promise.catch(() => { })
        const activeRun: IActiveAgentRun = {
            runId,
            promptId: prompt.id,
            abortController,
            accepted: accepted.promise,
            resolveAccepted: accepted.resolve,
            rejectAccepted: accepted.reject,
            settled: settled.promise,
            resolveSettled: settled.resolve,
            rejectSettled: settled.reject,
            acceptedCompleted: false,
            acceptingQueuedInput: true,
        }
        this.activeRun = activeRun
        this.stateValue = {
            ...this.stateValue,
            isRunning: true,
            activeRunId: runId,
            streamingMessage: undefined,
            pendingToolCallIds: new Set(),
            pendingToolApproval: undefined,
            errorMessage: undefined,
            lastRunReason: undefined,
        }

        void this.executeRun(activeRun, prompt, runConfiguration, context)

        return {
            runId,
            accepted: activeRun.accepted,
            settled: activeRun.settled,
        }
    }

    steer(text: string): void {
        this.enqueueQueuedMessage(text, "steer")
    }

    followUp(text: string): void {
        // Follow-up nie zmienia bieżącego turnu. Czeka, aż skończą się tool
        // continuation i steering, a dopiero potem uruchamia kolejny request.
        this.enqueueQueuedMessage(text, "followUp")
    }

    clearQueuedMessages(): IQueuedAgentMessages {
        const messages = {
            steering: structuredClone(this.steeringQueue),
            followUp: structuredClone(this.followUpQueue),
        }
        this.steeringQueue = []
        this.followUpQueue = []
        return messages
    }

    resolveToolApproval(
        approvalId: string,
        decision: TToolApprovalDecision,
    ): void {
        const pending = this.pendingToolApproval
        if (!pending) throw new Error("No tool approval is pending")
        if (pending.request.id !== approvalId) {
            throw new Error(
                `Tool approval ID mismatch: expected "${pending.request.id}", received "${approvalId}"`,
            )
        }
        assertToolApprovalDecision(pending.request, decision)
        this.resolveToolApprovalRequest(pending, decision)
    }

    private enqueueQueuedMessage(
        text: string,
        source: "steer" | "followUp",
    ): void {
        const label = source === "steer" ? "Steering" : "Follow-up"
        if (!text.trim()) throw new Error(`${label} message cannot be empty`)
        const activeRun = this.activeRun
        if (!activeRun?.acceptingQueuedInput || !activeRun.acceptedCompleted) {
            throw new Error(`Agent is not accepting ${label.toLowerCase()} messages`)
        }

        const message = this.createUserMessage(text, activeRun.runId, source)
        if (source === "steer") this.steeringQueue.push(message)
        else this.followUpQueue.push(message)
    }

    async abort(): Promise<void> {
        await this.waitForRuns(true)
    }

    waitForIdle(): Promise<void> {
        return this.waitForRuns(false)
    }

    clear(): void {
        if (this.activeRun) throw new Error("Cannot clear while Agent is running")
        this.steeringQueue = []
        this.followUpQueue = []
        this.stateValue = {
            ...this.stateValue,
            messages: [],
            isRunning: false,
            activeRunId: undefined,
            streamingMessage: undefined,
            pendingToolCallIds: new Set(),
            pendingToolApproval: undefined,
            errorMessage: undefined,
            lastRunReason: undefined,
        }
    }

    restoreMessages(messages: readonly TAgentMessage[]): void {
        if (this.activeRun) {
            throw new Error("Cannot restore messages while Agent is running")
        }
        this.stateValue = {
            ...this.stateValue,
            messages: structuredClone(messages),
            streamingMessage: undefined,
            pendingToolCallIds: new Set(),
            pendingToolApproval: undefined,
        }
    }

    private async executeRun(
        activeRun: IActiveAgentRun,
        prompt: IUserMessage,
        runConfiguration: IAgentRunConfiguration,
        context: ReturnType<TAgentContextProjector>,
    ): Promise<void> {
        let reason: TAgentRunEndReason = "internal-error"
        let failed = false
        let failure: unknown

        try {
            const result = await runAgentLoop({
                sessionId: this.stateValue.sessionId,
                runId: activeRun.runId,
                systemPrompt: this.stateValue.systemPrompt,
                messages: context.messages,
                ...(context.contextSummary === undefined
                    ? {}
                    : { contextSummary: context.contextSummary }),
                prompt,
                model: runConfiguration.model,
                ...(runConfiguration.modelProfile === undefined
                    ? {}
                    : { modelProfile: runConfiguration.modelProfile }),
                reasoningEffort: runConfiguration.reasoningEffort,
                tools: this.stateValue.tools,
                signal: activeRun.abortController.signal,
                emit: (event) => this.processEvent(event, activeRun),
                requestApproval: (draft, approvalContext) => {
                    if (
                        approvalContext.sessionId !== this.stateValue.sessionId
                        || approvalContext.runId !== activeRun.runId
                    ) {
                        throw new Error(
                            "Tool approval context does not match the active run",
                        )
                    }
                    return this.requestToolApproval(
                        draft,
                        approvalContext.toolCallId,
                        activeRun,
                    )
                },
                hasSteeringMessages: () =>
                    this.hasSteeringMessages(activeRun),
                takeSteeringMessage: () =>
                    this.takeSteeringMessage(activeRun),
                hasFollowUpMessages: () =>
                    this.hasFollowUpMessages(activeRun),
                takeFollowUpMessage: () =>
                    this.takeFollowUpMessage(activeRun),
                restoreQueuedMessage: (message) =>
                    this.restoreQueuedMessage(activeRun, message),
                closeQueuedInput: () => this.closeQueuedInput(activeRun),
                now: this.now,
                generateId: this.generateId,
            })
            reason = result.reason

        } catch (error) {
            failed = true
            failure = error
            if (!activeRun.acceptedCompleted) {
                activeRun.acceptedCompleted = true
                activeRun.rejectAccepted(error)
            }

        } finally {
            this.abortPendingToolApproval(activeRun)
            if (!activeRun.acceptedCompleted) {
                const error = failed
                    ? failure
                    : new Error("Agent run ended before prompt acceptance")
                activeRun.acceptedCompleted = true
                activeRun.rejectAccepted(error)
                if (!failed) {
                    failed = true
                    failure = error
                }
            }

            activeRun.acceptingQueuedInput = false

            if (this.activeRun === activeRun) {
                const errorMessage = failed
                    ? toErrorMessage(failure)
                    : this.stateValue.errorMessage
                this.stateValue = {
                    ...this.stateValue,
                    isRunning: false,
                    activeRunId: undefined,
                    streamingMessage: undefined,
                    pendingToolCallIds: new Set(),
                    pendingToolApproval: undefined,
                    errorMessage,
                    lastRunReason: reason,
                }

                this.activeRun = undefined

                this.notifyListeners({
                    type: "agent_settled",
                    runId: activeRun.runId,
                    reason,
                    ...(errorMessage === undefined ? {} : { errorMessage }),
                }, activeRun.abortController.signal)

                if (failed) activeRun.rejectSettled(failure)
                else activeRun.resolveSettled()
            }
        }
    }

    private async waitForRuns(abort: boolean): Promise<void> {
        let failed = false
        let firstFailure: unknown
        while (this.activeRun) {
            const activeRun = this.activeRun
            if (abort) {
                activeRun.acceptingQueuedInput = false
                activeRun.abortController.abort("Buli interaction was aborted")
                this.abortPendingToolApproval(activeRun)
            }
            try {
                await activeRun.settled
            } catch (error) {
                if (!failed) {
                    failed = true
                    firstFailure = error
                }
            }
        }
        if (failed) throw firstFailure
    }

    private async processEvent(
        event: IAgentEvent,
        activeRun: IActiveAgentRun,
    ): Promise<void> {
        const signal = activeRun.abortController.signal
        await this.criticalEventSink?.(event, signal)
        this.reduce(event)
        this.notifyListeners(event, signal)

        if (
            event.type === "message_end"
            && event.message.role === "user"
            && event.message.id === activeRun.promptId
            && !activeRun.acceptedCompleted
        ) {
            activeRun.acceptedCompleted = true
            activeRun.resolveAccepted()
        }
    }

    private notifyListeners(event: IAgentEvent, signal: AbortSignal): void {
        for (const listener of [...this.listeners]) {
            try {
                const result = listener(event, signal)
                if (result) {
                    void result.catch((error: unknown) => {
                        this.onObserverError?.(error)
                    })
                }
            } catch (error) {
                this.onObserverError?.(error)
            }
        }
    }

    private hasSteeringMessages(activeRun: IActiveAgentRun): boolean {
        return this.activeRun === activeRun && this.steeringQueue.length > 0
    }

    private hasFollowUpMessages(activeRun: IActiveAgentRun): boolean {
        return this.activeRun === activeRun && this.followUpQueue.length > 0
    }

    private takeSteeringMessage(
        activeRun: IActiveAgentRun,
    ): IUserMessage | undefined {
        if (this.activeRun !== activeRun) return undefined
        return this.steeringQueue.shift()
    }

    private takeFollowUpMessage(
        activeRun: IActiveAgentRun,
    ): IUserMessage | undefined {
        if (this.activeRun !== activeRun) return undefined
        return this.followUpQueue.shift()
    }

    private restoreQueuedMessage(
        activeRun: IActiveAgentRun,
        message: IUserMessage,
    ): void {
        if (this.activeRun !== activeRun) return
        if (message.source === "steer") this.steeringQueue.unshift(message)
        if (message.source === "followUp") this.followUpQueue.unshift(message)
    }

    private closeQueuedInput(activeRun: IActiveAgentRun): void {
        if (this.activeRun === activeRun) activeRun.acceptingQueuedInput = false
    }

    private requestToolApproval(
        draft: TToolApprovalDraft,
        toolCallId: string,
        activeRun: IActiveAgentRun,
    ): Promise<TToolApprovalDecision> {
        if (this.activeRun !== activeRun) {
            return Promise.reject(new Error("Agent run is no longer active"))
        }
        if (activeRun.abortController.signal.aborted) {
            return Promise.reject(new Error("Buli interaction was aborted"))
        }
        if (this.pendingToolApproval) {
            return Promise.reject(new Error(
                `Tool approval already pending: ${this.pendingToolApproval.request.id}`,
            ))
        }

        const request = createToolApprovalRequest(
            draft,
            this.generateToolApprovalId(),
            this.stateValue.sessionId,
            activeRun.runId,
            toolCallId,
        )
        const deferred = Promise.withResolvers<TToolApprovalDecision>()
        void deferred.promise.catch(() => { })
        const pending: IPendingToolApproval = {
            activeRun,
            request,
            resolve: deferred.resolve,
            reject: deferred.reject,
        }
        this.pendingToolApproval = pending
        this.publishEphemeralEvent({
            type: "tool_approval_requested",
            runId: activeRun.runId,
            request,
        }, activeRun)
        return deferred.promise
    }

    private abortPendingToolApproval(activeRun: IActiveAgentRun): void {
        const pending = this.pendingToolApproval
        if (pending?.activeRun !== activeRun) return

        this.pendingToolApproval = undefined
        this.publishEphemeralEvent({
            type: "tool_approval_resolved",
            runId: activeRun.runId,
            approvalId: pending.request.id,
            decision: undefined,
        }, activeRun)
        pending.reject(new Error(
            toolApprovalAbortMessage(activeRun.abortController.signal),
        ))
    }

    private generateToolApprovalId(): string {
        const base = this.generateId()
        let id = base
        let suffix = 1
        while (this.issuedToolApprovalIds.has(id)) {
            id = `${base}-${suffix}`
            suffix += 1
        }
        this.issuedToolApprovalIds.add(id)
        return id
    }

    private resolveToolApprovalRequest(
        pending: IPendingToolApproval,
        decision: TToolApprovalDecision,
    ): void {
        if (this.pendingToolApproval !== pending) return
        this.pendingToolApproval = undefined
        this.publishEphemeralEvent({
            type: "tool_approval_resolved",
            runId: pending.activeRun.runId,
            approvalId: pending.request.id,
            decision,
        }, pending.activeRun)
        pending.resolve(decision)
    }

    private publishEphemeralEvent(
        event: IAgentEvent,
        activeRun: IActiveAgentRun,
    ): void {
        this.reduce(event)
        this.notifyListeners(event, activeRun.abortController.signal)
    }

    private reduce(event: IAgentEvent): void {
        this.stateValue = reduceAgentState(this.stateValue, event)
    }

    private createUserMessage(
        text: string,
        runId: string,
        source: TUserMessageSource,
    ): IUserMessage {
        return {
            id: this.generateId(),
            sessionId: this.stateValue.sessionId,
            runId,
            role: "user",
            source,
            content: text,
            createdAt: this.now(),
        }
    }
}

function toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
