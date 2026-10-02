import type { TAgentMessage } from "@/agent"
import type { IRequiredContext } from "@/sessions/history-contracts"

/** One complete immutable model context; neither a durable archive nor a UI history page. */
export class AgentWorkingContext {
    private context: IRequiredContext

    constructor(context: IRequiredContext) {
        this.context = immutableContext(context)
    }

    readonly getContext = (): IRequiredContext => this.context

    /** Called only after durable acceptance. Existing frozen messages are shared, not cloned. */
    readonly acceptCommittedMessage = (message: TAgentMessage): void => {
        const accepted = immutableCopy(message)
        const messages = Object.freeze([...this.context.messages, accepted])
        this.context = Object.freeze({ ...this.context, messages })
    }

    /** Prepare everything first: a failed copy/freeze leaves the old immutable view untouched. */
    readonly replaceContext = (context: IRequiredContext): void => {
        const replacement = immutableContext(context)
        this.context = replacement
    }
}

function immutableContext(context: IRequiredContext): IRequiredContext {
    return Object.freeze({
        messages: Object.freeze(context.messages.map(immutableCopy)),
        ...(context.contextSummary === undefined ? {} : { contextSummary: context.contextSummary }),
        ...(context.checkpoint === undefined ? {} : { checkpoint: immutableCopy(context.checkpoint) }),
    })
}

function immutableCopy<T>(value: T): T {
    const copy = structuredClone(value)
    const pending: unknown[] = [copy]
    const visited = new WeakSet<object>()
    while (pending.length > 0) {
        const current = pending.pop()
        if (current === null || typeof current !== "object" || visited.has(current)) continue
        visited.add(current)
        for (const child of Object.values(current)) pending.push(child)
        Object.freeze(current)
    }
    return copy
}
