import {
    runAgentLoop,
    type IAgentContext,
    type IAgentInputQueue,
    type IAgentLoopConfig,
} from "@/agent/engine/agent-loop"
import type {
    TAgentCriticalEventSink,
    TAgentEvent,
    TAgentEventListener,
} from "@/agent/events"
import type {
    IAgentRunConfiguration,
    TAgentRunConfigurationResolver,
} from "@/agent/model"
import type {
    TAgentMessage,
    TUserInput,
    IUserInputContent,
    IUserMessage,
    TUserMessageSource,
    IUserPathReference,
} from "@/agent/messages"
import { USER_PATH_REFERENCES_PER_SESSION_MAX } from "@/agent/messages"
import type {
    TAgentContextProjector,
    TAgentRunEndReason,
    IAgentRunHandle,
    IAgentState,
} from "@/agent/state"
import { reduceAgentState } from "@/agent/engine/state-reducer"
import type { IRuntimeAgentTool } from "@/agent/tool"
import type { IToolOutputStore } from "@/agent/tool-output-store"
import { generateRandomId } from "@/common/ids"

export interface IAgentOptions {
    readonly sessionId: string
    readonly systemPrompt: string
    readonly resolveRunConfiguration: TAgentRunConfigurationResolver
    readonly tools: readonly IRuntimeAgentTool[]
    readonly initialMessages?: readonly TAgentMessage[]
    readonly projectContext?: TAgentContextProjector
    readonly criticalEventSink?: TAgentCriticalEventSink
    readonly onObserverError?: (error: unknown) => void
    readonly now?: () => number
    readonly generateId?: () => string
    readonly toolOutputStore?: IToolOutputStore
}

interface IActiveAgentRun {
    readonly runId: string
    readonly promptId: string
    readonly abortController: AbortController
    readonly initialPromptProcessed: Promise<void>
    readonly resolveInitialPromptProcessed: () => void
    readonly rejectInitialPromptProcessed: (reason?: unknown) => void
    readonly runFinished: Promise<void>
    readonly resolveRunFinished: () => void
    readonly rejectRunFinished: (reason?: unknown) => void
    initialPromptProcessingCompleted: boolean
    acceptingQueuedInput: boolean
}

interface IQueuedAgentMessages {
    readonly steering: readonly IUserMessage[]
    readonly followUp: readonly IUserMessage[]
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
    private readonly toolOutputStore: IToolOutputStore | undefined
    private steeringQueue: IUserMessage[] = []
    private followUpQueue: IUserMessage[] = []
    private queuedMessagesRevisionValue = 0
    private activeRun: IActiveAgentRun | undefined

    constructor(options: IAgentOptions) {
        this.resolveRunConfiguration = options.resolveRunConfiguration
        this.criticalEventSink = options.criticalEventSink
        this.onObserverError = options.onObserverError
        this.now = options.now ?? Date.now
        this.generateId = options.generateId ?? generateRandomId
        this.projectContext = options.projectContext
        this.toolOutputStore = options.toolOutputStore
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

    /**
     * Queues mutate in place, so array identity is not a valid publication key.
     * Session snapshots use this token to avoid cloning unchanged queues on every
     * text delta; public queue getters still return independent mutable copies.
     * Enqueue, consume, rollback restoration, clear and reset all invalidate it.
     */
    get queuedMessagesRevision(): number {
        return this.queuedMessagesRevisionValue
    }

    subscribe(listener: TAgentEventListener): () => void {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
    }

    prompt(input: TUserInput): IAgentRunHandle {
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

        const runConfiguration: IAgentRunConfiguration = this.resolveRunConfiguration()
        const context = this.projectContext?.(this.stateValue.messages) ?? {
            messages: this.stateValue.messages,
        }
        const runId = this.generateId()
        const prompt = this.createUserMessage(normalizedInput, runId, "prompt")
        const abortController = new AbortController()
        const initialPromptProcessed = Promise.withResolvers<void>()
        const runFinished = Promise.withResolvers<void>()
        // Consumers may intentionally observe only one phase of the run.
        void initialPromptProcessed.promise.catch(() => { })
        void runFinished.promise.catch(() => { })
        const activeRun: IActiveAgentRun = {
            runId,
            promptId: prompt.id,
            abortController,
            initialPromptProcessed: initialPromptProcessed.promise,
            resolveInitialPromptProcessed: initialPromptProcessed.resolve,
            rejectInitialPromptProcessed: initialPromptProcessed.reject,
            runFinished: runFinished.promise,
            resolveRunFinished: runFinished.resolve,
            rejectRunFinished: runFinished.reject,
            initialPromptProcessingCompleted: false,
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

        void this.executeRun(
            activeRun,
            prompt,
            runConfiguration,
            context,
        )

        return {
            runId,
            initialPromptProcessed: activeRun.initialPromptProcessed,
            runFinished: activeRun.runFinished,
        }
    }

    steer(input: TUserInput): void {
        this.enqueueQueuedMessage(input, "steer")
    }

    followUp(input: TUserInput): void {
        // Follow-up nie zmienia bieżącego turnu. Czeka, aż skończą się tool
        // continuation i steering, a dopiero potem uruchamia kolejny request.
        this.enqueueQueuedMessage(input, "followUp")
    }

    clearQueuedMessages(): IQueuedAgentMessages {
        const messages = {
            steering: structuredClone(this.steeringQueue),
            followUp: structuredClone(this.followUpQueue),
        }
        if (this.steeringQueue.length > 0 || this.followUpQueue.length > 0) {
            this.queuedMessagesRevisionValue += 1
        }
        this.steeringQueue = []
        this.followUpQueue = []
        return messages
    }

    private enqueueQueuedMessage(
        input: TUserInput,
        source: "steer" | "followUp",
    ): void {
        const normalizedInput = normalizeUserInput(input)
        const label = source === "steer" ? "Steering" : "Follow-up"
        if (!normalizedInput.text.trim() && !normalizedInput.attachments?.length) {
            throw new Error(`${label} message cannot be empty`)
        }
        const activeRun = this.activeRun
        if (
            !activeRun?.acceptingQueuedInput
            || !activeRun.initialPromptProcessingCompleted
        ) {
            throw new Error(`Agent is not accepting ${label.toLowerCase()} messages`)
        }

        const message = this.createUserMessage(
            normalizedInput,
            activeRun.runId,
            source,
        )
        if (source === "steer") this.steeringQueue.push(message)
        else this.followUpQueue.push(message)
        this.queuedMessagesRevisionValue += 1
    }

    async abort(): Promise<void> {
        await this.waitForRuns(true)
    }

    waitForIdle(): Promise<void> {
        return this.waitForRuns(false)
    }

    reset(): void {
        if (this.activeRun) throw new Error("Cannot reset while Agent is running")
        if (this.steeringQueue.length > 0 || this.followUpQueue.length > 0) {
            this.queuedMessagesRevisionValue += 1
        }
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
        context: ReturnType<TAgentContextProjector>,
    ): Promise<void> {
        let reason: TAgentRunEndReason = "internal-error"
        let failed = false
        let failure: unknown

        try {
            const agentContext: IAgentContext = {
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
            const inputQueue: IAgentInputQueue = {
                hasSteering: () => this.hasSteeringMessages(activeRun),
                takeSteering: () => this.takeSteeringMessage(activeRun),
                hasFollowUp: () => this.hasFollowUpMessages(activeRun),
                takeFollowUp: () => this.takeFollowUpMessage(activeRun),
                restore: (message) =>
                    this.restoreQueuedMessage(activeRun, message),
                close: () => this.closeQueuedInput(activeRun),
            }
            const loopConfig: IAgentLoopConfig = {
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
                inputQueue,
                now: this.now,
                generateId: this.generateId,
                ...(this.toolOutputStore === undefined
                    ? {}
                    : { toolOutputStore: this.toolOutputStore }),
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
            if (!activeRun.initialPromptProcessingCompleted) {
                activeRun.initialPromptProcessingCompleted = true
                activeRun.rejectInitialPromptProcessed(error)
            }

        } finally {
            if (!activeRun.initialPromptProcessingCompleted) {
                const error = failed
                    ? failure
                    : new Error("Agent run ended before processing the initial prompt")
                activeRun.initialPromptProcessingCompleted = true
                activeRun.rejectInitialPromptProcessed(error)
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

                if (failed) activeRun.rejectRunFinished(failure)
                else activeRun.resolveRunFinished()
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
                await activeRun.runFinished
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
        event: TAgentEvent,
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
            && !activeRun.initialPromptProcessingCompleted
        ) {
            activeRun.initialPromptProcessingCompleted = true
            activeRun.resolveInitialPromptProcessed()
        }
    }

    private notifyListeners(event: TAgentEvent, signal: AbortSignal): void {
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
        const message = this.steeringQueue.shift()
        if (message) this.queuedMessagesRevisionValue += 1
        return message
    }

    private takeFollowUpMessage(
        activeRun: IActiveAgentRun,
    ): IUserMessage | undefined {
        if (this.activeRun !== activeRun) return undefined
        const message = this.followUpQueue.shift()
        if (message) this.queuedMessagesRevisionValue += 1
        return message
    }

    private restoreQueuedMessage(
        activeRun: IActiveAgentRun,
        message: IUserMessage,
    ): void {
        if (this.activeRun !== activeRun) return
        if (message.source === "steer") this.steeringQueue.unshift(message)
        if (message.source === "followUp") this.followUpQueue.unshift(message)
        if (message.source === "steer" || message.source === "followUp") {
            this.queuedMessagesRevisionValue += 1
        }
    }

    private closeQueuedInput(activeRun: IActiveAgentRun): void {
        if (this.activeRun === activeRun) activeRun.acceptingQueuedInput = false
    }

    private reduce(event: TAgentEvent): void {
        this.stateValue = reduceAgentState(this.stateValue, event)
    }

    private createUserMessage(
        input: IUserInputContent,
        runId: string,
        source: TUserMessageSource,
    ): IUserMessage {
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

function normalizeUserInput(input: TUserInput): IUserInputContent {
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
    messages: readonly TAgentMessage[],
    prompt: IUserMessage,
): IUserPathReference[] {
    const references: IUserPathReference[] = []
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
