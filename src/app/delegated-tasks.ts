import { Buffer } from "node:buffer"
import type { IAgentDefinition, IAgentToolContext } from "@/agent"
import { AgentSession, type ISessionManager } from "@/sessions"
import type { IAgentSessionRunConfiguration } from "@/sessions"
import type { IDelegatedTask } from "@/sessions"
import type { IToolOutputStore } from "@/agent"

const TASK_TIMEOUT_MS = 10 * 60 * 1000

/** Keep the entire group below the tool executor's 50 KB bound without breaking JSON. */
function boundedReport(answer: string): string {
    if (Buffer.byteLength(JSON.stringify(answer), "utf8") <= 12_000) return answer
    let low = 0
    let high = answer.length
    while (low < high) {
        const middle = Math.ceil((low + high) / 2)
        if (Buffer.byteLength(JSON.stringify(answer.slice(0, middle)), "utf8") <= 11_500) low = middle
        else high = middle - 1
    }
    return answer.slice(0, low) + "\n[Report truncated. Full report is available in the delegated task history.]"
}

export interface IDelegatedTaskInput {
    readonly agent: string
    readonly task: string
}

/** Owns child executions, while SQLite owns completed history. */
export class DelegatedTasks {
    private readonly children = new Map<string, AgentSession>()
    private readonly listeners = new Set<() => void>()
    private readonly agents: ReadonlyMap<string, IAgentDefinition>
    private revision = 0

    constructor(private readonly options: {
        readonly manager: ISessionManager
        /** Explorer and any configured subagents, by id. */
        readonly agents: readonly IAgentDefinition[]
        readonly toolOutputStore?: IToolOutputStore
    }) {
        this.agents = new Map(options.agents.map((agent) => [agent.id, agent]))
        if (this.agents.size !== options.agents.length) throw new Error("Delegated agents need unique ids")
    }

    readonly subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener)
        return () => { this.listeners.delete(listener) }
    }
    readonly getSnapshot = (): number => this.revision
    private notify(): void {
        this.revision++
        for (const listener of this.listeners) listener()
    }

    readonly list = (sessionId: string, assistantMessageId: string, toolCallId: string) =>
        this.options.manager.loadDelegatedTasks(sessionId, assistantMessageId, toolCallId)

    readonly open = (id: string): AgentSession => {
        const existing = this.children.get(id)
        if (existing) return existing
        const agentId = this.options.manager.getSessionInfo(id)?.agentId
        const agent = agentId === undefined ? undefined : this.agents.get(agentId)
        if (!agent) throw new Error("Delegated task history not found")
        this.options.manager.openSession(id)
        const session = this.createSession(id, agent, () => { throw new Error("Archived delegated task cannot run") })
        this.children.set(id, session)
        return session
    }

    readonly currentTool = (id: string): string | undefined => {
        return this.children.get(id)?.getActiveToolName()
    }

    readonly abort = async (id: string): Promise<void> => { await this.children.get(id)?.abort() }

    /** Runs each task with the agent it names. */
    async run(tasks: readonly IDelegatedTaskInput[], context: IAgentToolContext, configuration: IAgentSessionRunConfiguration): Promise<string> {
        context.signal.throwIfAborted()
        const agents = tasks.map((input) => this.agents.get(input.agent))
        if (agents.some((agent) => agent === undefined)) throw new Error("Unknown delegated agent")
        if (!context.assistantMessageId) throw new Error("Missing parent assistant message")
        const controller = new AbortController()
        const signal = AbortSignal.any([context.signal, controller.signal])
        const records: { readonly record: IDelegatedTask; readonly agent: IAgentDefinition }[] = []
        try {
            for (const [position, input] of tasks.entries()) {
                const agent = agents[position]!
                const id = crypto.randomUUID()
                const createdAt = Date.now()
                const record: IDelegatedTask = {
                    id, childSessionId: id, parentSessionId: context.sessionId,
                    assistantMessageId: context.assistantMessageId, toolCallId: context.toolCallId,
                    position, task: input.task, modelId: configuration.modelProfile?.modelId ?? "inherited",
                    reasoningEffort: configuration.reasoningEffort, status: "running", createdAt,
                    agentId: agent.id,
                }
                this.options.manager.createDelegatedTask({
                    id, agentId: agent.id, title: input.task.slice(0, 120), createdAt, updatedAt: createdAt,
                }, record)
                records.push({ record, agent })
            }
            const pending = records.map(async ({ record, agent }) => {
                try { return await this.runTask(record, agent, configuration, signal) }
                catch (error) { controller.abort(error); throw error }
            })
            this.notify()
            // Wait for every child to settle even when persistence fails in one of them.
            const settled = await Promise.allSettled(pending)
            const failure = settled.find((result) => result.status === "rejected")
            if (failure?.status === "rejected") throw failure.reason
            return JSON.stringify({ results: settled.map((result) => {
                if (result.status !== "fulfilled") throw new Error("Unreachable task state")
                const task = result.value
                const answer = task.answer === undefined ? undefined : boundedReport(task.answer)
                return { taskId: task.id, position: task.position + 1, status: task.status,
                    answer, truncated: answer !== task.answer, error: task.error?.slice(0, 1000) }
            }) })
        } catch (error) {
            controller.abort(error)
            for (const { record } of records) {
                const current = this.list(record.parentSessionId, record.assistantMessageId, record.toolCallId).find((task) => task.id === record.id)
                if (current?.status === "running") this.options.manager.updateDelegatedTask({
                    ...current, status: "failed", finishedAt: Date.now(), error: "Delegation could not finish",
                })
            }
            this.notify()
            throw error
        }
    }

    private createSession(id: string, agent: IAgentDefinition, resolveRunConfiguration: () => IAgentSessionRunConfiguration): AgentSession {
        return new AgentSession({
            agentId: agent.id, sessionId: id, manager: this.options.manager,
            systemPrompt: agent.systemPrompt, tools: agent.tools,
            resolveRunConfiguration,
            ...(this.options.toolOutputStore ? { toolOutputStore: this.options.toolOutputStore } : {}),
        })
    }

    private async runTask(record: IDelegatedTask, agent: IAgentDefinition, configuration: IAgentSessionRunConfiguration, signal: AbortSignal): Promise<IDelegatedTask> {
        const child = this.createSession(record.childSessionId, agent, () => configuration)
        this.children.set(record.childSessionId, child)
        let timedOut = false
        let abortFailure: unknown
        let abortTask: Promise<void> | undefined
        const abort = () => {
            abortTask ??= child.abort().catch((error: unknown) => { abortFailure = error })
        }
        const timer = setTimeout(() => { timedOut = true; abort() }, TASK_TIMEOUT_MS)
        signal.addEventListener("abort", abort, { once: true })
        let executionError: unknown
        try {
            if (signal.aborted) abort()
            else {
                const handle = child.prompt(record.task)
                await Promise.all([handle.initialPromptProcessed, handle.runFinished])
            }
        } catch (error) { executionError = error }
        finally {
            clearTimeout(timer)
            signal.removeEventListener("abort", abort)
            await abortTask
        }
        if (abortFailure) throw abortFailure
        // Persistence failures are not ordinary research failures.
        child.assertPersistenceAvailable()
        const messages = this.options.manager.loadRequiredContext(record.childSessionId).messages
        const last = messages.at(-1)
        const answer = last?.role === "assistant"
            ? last.content.filter((part) => part.type === "text").map((part) => part.text).join("\n")
            : ""
        const status = timedOut ? "failed" : signal.aborted || child.state.lastRunReason === "aborted" ? "cancelled"
            : !executionError && child.state.lastRunReason === "completed" && answer.trim() ? "completed" : "failed"
        const result: IDelegatedTask = {
            ...record, status, finishedAt: Date.now(),
            ...(status === "completed" ? { answer } : {
                error: timedOut ? `${agent.name} exceeded the 10-minute limit` : executionError instanceof Error
                    ? executionError.message : child.state.errorMessage ?? `${agent.name} ${status}`,
            }),
        }
        this.options.manager.updateDelegatedTask(result)
        this.notify()
        return result
    }

    async dispose(): Promise<void> {
        await Promise.all([...this.children.values()].map((child) => child.dispose()))
        for (const id of this.children.keys()) this.options.manager.releaseSession(id)
        this.children.clear()
        this.listeners.clear()
    }
}
