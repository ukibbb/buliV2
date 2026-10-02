import type { TAgentMessage } from "@/agent"
import type { ISessionSource } from "@/app/contracts"
import type { ICompactionCheckpoint, ISessionSnapshot } from "@/sessions"

/** Input data for renderer tests; history is never exposed by getSnapshot(). */
export interface ISessionTestData extends ISessionSnapshot {
    readonly messages: readonly TAgentMessage[]
    readonly compactionCheckpoint?: ICompactionCheckpoint
}

export function createSessionTestSource(initial: ISessionTestData) {
    let data = initial
    let snapshot = operationalSnapshot(initial)
    const liveListeners = new Set<() => void>()
    const historyListeners = new Set<() => void>()
    const source: ISessionSource = {
        getSnapshot: () => snapshot,
        subscribe: (listener) => { liveListeners.add(listener); return () => liveListeners.delete(listener) },
        subscribeHistory: (listener) => { historyListeners.add(listener); return () => historyListeners.delete(listener) },
        loadHistoryPage: (branchId) => ({
            sessionId: data.messages[0]?.sessionId ?? "test-session",
            branchId,
            messages: data.messages,
            ...(data.compactionCheckpoint ? { checkpoint: data.compactionCheckpoint } : {}),
        }),
    }
    return {
        source,
        getData: () => data,
        setData(next: ISessionTestData) {
            const historyChanged = next.messages !== data.messages || next.compactionCheckpoint !== data.compactionCheckpoint
            data = next
            snapshot = operationalSnapshot(next)
            for (const listener of liveListeners) listener()
            if (historyChanged) for (const listener of historyListeners) listener()
        },
    }
}

function operationalSnapshot(data: ISessionTestData): ISessionSnapshot {
    const { messages, compactionCheckpoint: _checkpoint, ...snapshot } = data
    const last = messages.at(-1)
    return {
        ...snapshot,
        ...(last?.role === "assistant" && last.errorMessage ? {
            assistantError: { id: last.id, runId: last.runId, errorMessage: last.errorMessage },
        } : {}),
    }
}
