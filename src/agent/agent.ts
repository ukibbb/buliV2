import { runAgentLoop } from "@/agent/agent-loop"
import type {
    IAgentEvent,
    IAgentRunConfiguration,
    IAgentRunHandle,
    IAgentState,
    IAgentTool,
    TAgentEventListener,
    TAgentCriticalEventSink,
    TAgentRunConfigurationResolver,
    TAgentRunEndReason,
} from "@/agent/agent-types"
import { generateRandomId } from "@/common"
import type {
    IUserMessage,
    TAgentMessage,
    TUserMessageSource,
} from "@/domain"

interface IAgentOptions {
    readonly sessionId: string
    readonly systemPrompt: string
    readonly resolveRunConfiguration: TAgentRunConfigurationResolver
    readonly tools: readonly IAgentTool[]
    readonly initialMessages?: readonly TAgentMessage[]
    readonly criticalEventSink?: TAgentCriticalEventSink
    readonly onObserverError?: (error: unknown) => void
    readonly maxProviderIterations?: number
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

/** Owns one session's live agent state and active run. */
export class Agent {
    private stateValue: IAgentState
    private readonly resolveRunConfiguration: TAgentRunConfigurationResolver
    private readonly criticalEventSink: TAgentCriticalEventSink | undefined
    private readonly onObserverError: ((error: unknown) => void) | undefined
    private readonly listeners = new Set<TAgentEventListener>()
    private readonly maxProviderIterations: number | undefined
    private readonly now: () => number
    private readonly generateId: () => string
    private steeringQueue: IUserMessage[] = []
    private followUpQueue: IUserMessage[] = []
    private activeRun: IActiveAgentRun | undefined

    constructor(options: IAgentOptions) {
        this.resolveRunConfiguration = options.resolveRunConfiguration
        this.criticalEventSink = options.criticalEventSink
        this.onObserverError = options.onObserverError
        this.maxProviderIterations = options.maxProviderIterations
        this.now = options.now ?? Date.now
        this.generateId = options.generateId ?? generateRandomId
        this.stateValue = {
            sessionId: options.sessionId,
            systemPrompt: options.systemPrompt,
            tools: [...options.tools],
            messages: structuredClone(options.initialMessages ?? []),
            isRunning: false,
            activeRunId: undefined,
            streamingMessage: undefined,
            pendingToolCallIds: new Set(),
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
        const runId = this.generateId()
        const prompt = this.createUserMessage(text, runId, "prompt")
        const abortController = new AbortController()
        const accepted = Promise.withResolvers<void>()
        const settled = Promise.withResolvers<void>()
        // Consumers may intentionally observe only one phase of the run.
        void accepted.promise.catch(() => {})
        void settled.promise.catch(() => {})
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
            errorMessage: undefined,
            lastRunReason: undefined,
        }

        void this.executeRun(activeRun, prompt, runConfiguration)

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
        }
    }

    private async executeRun(
        activeRun: IActiveAgentRun,
        prompt: IUserMessage,
        runConfiguration: IAgentRunConfiguration,
    ): Promise<void> {
        let reason: TAgentRunEndReason = "internal-error"
        let failed = false
        let failure: unknown

        try {
            const result = await runAgentLoop({
                sessionId: this.stateValue.sessionId,
                runId: activeRun.runId,
                systemPrompt: this.stateValue.systemPrompt,
                messages: this.stateValue.messages,
                prompt,
                model: runConfiguration.model,
                reasoningEffort: runConfiguration.reasoningEffort,
                tools: this.stateValue.tools,
                signal: activeRun.abortController.signal,
                emit: (event) => this.processEvent(event, activeRun),
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
                ...(this.maxProviderIterations === undefined
                    ? {}
                    : { maxProviderIterations: this.maxProviderIterations }),
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
                    lastRunReason: event.reason,
                }
                return
            case "agent_settled":
            case "turn_start":
                return
        }
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
