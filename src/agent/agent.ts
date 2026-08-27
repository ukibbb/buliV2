import {
    runAgentLoop,
    type AgentContext,
    type AgentInputQueue,
    type AgentLoopConfig,
} from "@/agent/agent-loop"
import type {
    AgentCriticalEventSink,
    AgentEvent,
    AgentEventListener,
} from "@/agent/events"
import type {
    AgentRunConfiguration,
    AgentRunConfigurationResolver,
} from "@/agent/model"
import type {
    AgentMessage,
    UserInput,
    UserInputContent,
    UserMessage,
    UserMessageSource,
    UserPathReference,
} from "@/agent/messages"
import { USER_PATH_REFERENCES_PER_SESSION_MAX } from "@/agent/messages"
import type {
    AgentContextProjector,
    AgentRunEndReason,
    AgentRunHandle,
    AgentState,
} from "@/agent/state"
import { reduceAgentState } from "@/agent/state-reducer"
import type { AgentTool } from "@/agent/tool"
import {
    assertToolApprovalDecision,
    createToolApprovalRequest,
    toolApprovalAbortMessage,
    type ToolApprovalDecision,
    type ToolApprovalDraft,
    type ToolApprovalRequest,
} from "@/agent/tool-approval"
import { generateRandomId } from "@/common/ids"

export interface AgentOptions {
    readonly sessionId: string
    readonly systemPrompt: string
    readonly resolveRunConfiguration: AgentRunConfigurationResolver
    readonly tools: readonly AgentTool[]
    readonly initialMessages?: readonly AgentMessage[]
    readonly projectContext?: AgentContextProjector
    readonly criticalEventSink?: AgentCriticalEventSink
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
    readonly steering: readonly UserMessage[]
    readonly followUp: readonly UserMessage[]
}

interface IPendingToolApproval {
    readonly activeRun: IActiveAgentRun
    readonly request: ToolApprovalRequest
    readonly resolve: (decision: ToolApprovalDecision) => void
    readonly reject: (reason?: unknown) => void
}

/** Public facade owning one session's live state, queued input, and active run. */
export class Agent {
    private stateValue: AgentState
    private readonly resolveRunConfiguration: AgentRunConfigurationResolver
    private readonly criticalEventSink: AgentCriticalEventSink | undefined
    private readonly onObserverError: ((error: unknown) => void) | undefined
    private readonly listeners = new Set<AgentEventListener>()
    private readonly now: () => number
    private readonly generateId: () => string
    private readonly projectContext: AgentContextProjector | undefined
    private steeringQueue: UserMessage[] = []
    private followUpQueue: UserMessage[] = []
    private activeRun: IActiveAgentRun | undefined
    private pendingToolApproval: IPendingToolApproval | undefined
    private readonly issuedToolApprovalIds = new Set<string>()

    constructor(options: AgentOptions) {
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

    get state(): AgentState {
        return this.stateValue
    }

    get pendingSteeringMessages(): readonly UserMessage[] {
        return structuredClone(this.steeringQueue)
    }

    get pendingFollowUpMessages(): readonly UserMessage[] {
        return structuredClone(this.followUpQueue)
    }

    subscribe(listener: AgentEventListener): () => void {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
    }

    prompt(input: UserInput): AgentRunHandle {
        const normalizedInput = normalizeUserInput(input)
        if (!normalizedInput.text.trim() && !normalizedInput.attachments?.length) {
            throw new Error("Prompt cannot be empty")
        }
        if (this.activeRun) {
            throw new Error("Agent is already processing a prompt")
        }
        if (this.steeringQueue.length > 0 || this.followUpQueue.length > 0) {
            throw new Error(
                "Restore queued messages before starting another prompt",
            )
        }

        const runConfiguration: AgentRunConfiguration = this.resolveRunConfiguration()
        const context = this.projectContext?.(this.stateValue.messages) ?? {
            messages: this.stateValue.messages,
        }
        const runId = this.generateId()
        const prompt = this.createUserMessage(normalizedInput, runId, "prompt")
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

        void this.executeRun(
            activeRun,
            prompt,
            runConfiguration,
            context,
        )

        return {
            runId,
            accepted: activeRun.accepted,
            settled: activeRun.settled,
        }
    }

    steer(input: UserInput): void {
        this.enqueueQueuedMessage(input, "steer")
    }

    followUp(input: UserInput): void {
        // Follow-up nie zmienia bieżącego turnu. Czeka, aż skończą się tool
        // continuation i steering, a dopiero potem uruchamia kolejny request.
        this.enqueueQueuedMessage(input, "followUp")
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
        decision: ToolApprovalDecision,
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
        input: UserInput,
        source: "steer" | "followUp",
    ): void {
        const normalizedInput = normalizeUserInput(input)
        const label = source === "steer" ? "Steering" : "Follow-up"
        if (!normalizedInput.text.trim() && !normalizedInput.attachments?.length) {
            throw new Error(`${label} message cannot be empty`)
        }
        const activeRun = this.activeRun
        if (!activeRun?.acceptingQueuedInput || !activeRun.acceptedCompleted) {
            throw new Error(`Agent is not accepting ${label.toLowerCase()} messages`)
        }

        const message = this.createUserMessage(
            normalizedInput,
            activeRun.runId,
            source,
        )
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

    restoreMessages(messages: readonly AgentMessage[]): void {
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
        prompt: UserMessage,
        runConfiguration: AgentRunConfiguration,
        context: ReturnType<AgentContextProjector>,
    ): Promise<void> {
        let reason: AgentRunEndReason = "internal-error"
        let failed = false
        let failure: unknown

        try {
            const agentContext: AgentContext = {
                systemPrompt: this.stateValue.systemPrompt,
                messages: context.messages,
                ...(context.contextSummary === undefined
                    ? {}
                    : { contextSummary: context.contextSummary }),
                tools: this.stateValue.tools,
                selectedPathReferences: collectPathReferences(
                    this.stateValue.messages,
                    prompt,
                ),
            }
            const inputQueue: AgentInputQueue = {
                hasSteering: () => this.hasSteeringMessages(activeRun),
                takeSteering: () => this.takeSteeringMessage(activeRun),
                hasFollowUp: () => this.hasFollowUpMessages(activeRun),
                takeFollowUp: () => this.takeFollowUpMessage(activeRun),
                restore: (message) =>
                    this.restoreQueuedMessage(activeRun, message),
                close: () => this.closeQueuedInput(activeRun),
            }
            const loopConfig: AgentLoopConfig = {
                sessionId: this.stateValue.sessionId,
                runId: activeRun.runId,
                model: runConfiguration.model,
                ...(runConfiguration.modelProfile === undefined
                    ? {}
                    : { modelProfile: runConfiguration.modelProfile }),
                ...(runConfiguration.providerAccountId === undefined
                    ? {}
                    : {
                        providerAccountId:
                            runConfiguration.providerAccountId,
                    }),
                reasoningEffort: runConfiguration.reasoningEffort,
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
                inputQueue,
                now: this.now,
                generateId: this.generateId,
            }
            const result = await runAgentLoop(
                prompt,
                agentContext,
                loopConfig,
            )
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
        event: AgentEvent,
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

    private notifyListeners(event: AgentEvent, signal: AbortSignal): void {
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
    ): UserMessage | undefined {
        if (this.activeRun !== activeRun) return undefined
        return this.steeringQueue.shift()
    }

    private takeFollowUpMessage(
        activeRun: IActiveAgentRun,
    ): UserMessage | undefined {
        if (this.activeRun !== activeRun) return undefined
        return this.followUpQueue.shift()
    }

    private restoreQueuedMessage(
        activeRun: IActiveAgentRun,
        message: UserMessage,
    ): void {
        if (this.activeRun !== activeRun) return
        if (message.source === "steer") this.steeringQueue.unshift(message)
        if (message.source === "followUp") this.followUpQueue.unshift(message)
    }

    private closeQueuedInput(activeRun: IActiveAgentRun): void {
        if (this.activeRun === activeRun) activeRun.acceptingQueuedInput = false
    }

    private requestToolApproval(
        draft: ToolApprovalDraft,
        toolCallId: string,
        activeRun: IActiveAgentRun,
    ): Promise<ToolApprovalDecision> {
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
        const deferred = Promise.withResolvers<ToolApprovalDecision>()
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
        decision: ToolApprovalDecision,
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
        event: AgentEvent,
        activeRun: IActiveAgentRun,
    ): void {
        this.reduce(event)
        this.notifyListeners(event, activeRun.abortController.signal)
    }

    private reduce(event: AgentEvent): void {
        this.stateValue = reduceAgentState(this.stateValue, event)
    }

    private createUserMessage(
        input: UserInputContent,
        runId: string,
        source: UserMessageSource,
    ): UserMessage {
        return {
            id: this.generateId(),
            sessionId: this.stateValue.sessionId,
            runId,
            role: "user",
            source,
            content: input.text,
            ...(input.references?.length
                ? { references: structuredClone(input.references) }
                : {}),
            ...(input.attachments?.length
                ? { attachments: structuredClone(input.attachments) }
                : {}),
            createdAt: this.now(),
        }
    }
}

function normalizeUserInput(input: UserInput): UserInputContent {
    if (typeof input === "string") return { text: input }
    return {
        text: input.text,
        ...(input.references?.length
            ? { references: structuredClone(input.references) }
            : {}),
        ...(input.attachments?.length
            ? { attachments: structuredClone(input.attachments) }
            : {}),
    }
}

function collectPathReferences(
    messages: readonly AgentMessage[],
    prompt: UserMessage,
): UserPathReference[] {
    const references: UserPathReference[] = []
    const seen = new Set<string>()
    const conversation = [...messages, prompt]
    outer: for (let messageIndex = conversation.length - 1; messageIndex >= 0; messageIndex -= 1) {
        const message = conversation[messageIndex]
        if (!message || message.role !== "user") continue
        const messageReferences = message.references ?? []
        for (
            let referenceIndex = messageReferences.length - 1;
            referenceIndex >= 0;
            referenceIndex -= 1
        ) {
            const reference = messageReferences[referenceIndex]
            if (!reference) continue
            const key = `${reference.kind}\0${reference.path}`
            if (seen.has(key)) continue
            seen.add(key)
            references.push(structuredClone(reference))
            if (references.length === USER_PATH_REFERENCES_PER_SESSION_MAX) {
                break outer
            }
        }
    }
    return references.reverse()
}

function toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
