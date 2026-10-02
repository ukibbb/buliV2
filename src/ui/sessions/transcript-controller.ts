import type { ISessionSource } from "@/app/contracts"
import type { IHistoryCursor, IHistoryPage, ISessionSnapshot } from "@/sessions"

export interface ITranscriptState {
    readonly page?: IHistoryPage
    readonly pageKind: "latest" | "older"
    readonly presentation: ISessionSnapshot
    readonly loading: boolean
    readonly error?: string
    readonly navigationRevision: number
}

/** Retains one page of payloads and only cursors for the return path. */
export class TranscriptController {
    private state: ITranscriptState
    private cursors: readonly IHistoryCursor[] = []
    private readonly listeners = new Set<() => void>()
    private generation = 0
    private disposed = false
    private unsubscribe: (() => void)[] = []

    constructor(private readonly source: ISessionSource) {
        this.state = { pageKind: "latest", presentation: source.getSnapshot(), loading: false, navigationRevision: 0 }
    }

    /** Subscribe only after mounting, never as a side effect of React rendering. */
    readonly connect = (): (() => void) => {
        if (this.unsubscribe.length > 0) return this.dispose
        this.disposed = false
        this.unsubscribe = [this.source.subscribe(this.onLiveUpdate), this.source.subscribeHistory(this.onHistoryUpdate)]
        return this.dispose
    }

    readonly getSnapshot = (): ITranscriptState => this.state
    readonly subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
    }

    readonly older = (): Promise<boolean> => {
        const cursor = this.state.page?.olderCursor
        return cursor ? this.load([...this.cursors, cursor], true) : Promise.resolve(false)
    }

    readonly newer = (): Promise<boolean> => this.cursors.length > 0
        ? this.load(this.cursors.slice(0, -1), true)
        : Promise.resolve(false)

    readonly latest = (): Promise<boolean> => this.load([], true)

    readonly dispose = (): void => {
        this.disposed = true
        this.generation++
        for (const unsubscribe of this.unsubscribe) unsubscribe()
        this.unsubscribe = []
    }

    private readonly onLiveUpdate = (): void => {
        const live = this.source.getSnapshot()
        if (live.activeBranchId !== this.state.presentation.activeBranchId) {
            void this.latest()
            return
        }
        if (this.state.pageKind === "older") return
        if (samePresentation(this.state.presentation, live)) return
        this.publish({ ...this.state, presentation: live })
    }

    private readonly onHistoryUpdate = (): void => {
        if (this.state.pageKind === "older") return
        void this.load([], false)
    }

    private async load(cursors: readonly IHistoryCursor[], navigation: boolean): Promise<boolean> {
        const generation = ++this.generation
        const branchId = this.source.getSnapshot().activeBranchId
        const cursor = cursors.at(-1)
        const { error: _error, ...previous } = this.state
        this.publish({ ...previous, loading: true })
        try {
            if (!this.isCurrent(generation, branchId)) return false
            const page = this.source.loadHistoryPage(branchId, cursor)
            if (!this.isCurrent(generation, branchId)) return false
            const presentation = this.source.getSnapshot()
            this.cursors = cursors
            this.publish({ page, pageKind: cursor === undefined ? "latest" : "older",
                presentation, loading: false,
                navigationRevision: this.state.navigationRevision + (navigation ? 1 : 0) })
            return true
        } catch (error) {
            if (!this.isCurrent(generation, branchId)) return false
            this.publish({ ...this.state, loading: false, error: error instanceof Error ? error.message : String(error) })
            return false
        }
    }

    private isCurrent(generation: number, branchId: string): boolean {
        return !this.disposed && generation === this.generation && branchId === this.source.getSnapshot().activeBranchId
    }

    private publish(state: ITranscriptState): void {
        if (this.disposed) return
        this.state = state
        for (const listener of this.listeners) listener()
    }
}

function samePresentation(previous: ISessionSnapshot, next: ISessionSnapshot): boolean {
    return previous.activeBranchId === next.activeBranchId
        && previous.activeRunId === next.activeRunId
        && previous.streamingMessage === next.streamingMessage
        && previous.compactionProgress === next.compactionProgress
        && previous.assistantError === next.assistantError
        && previous.isCompacting === next.isCompacting
        && previous.isRunning === next.isRunning
        && previous.pendingToolCallIds === next.pendingToolCallIds
}
