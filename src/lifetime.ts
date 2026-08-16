import { AsyncLocalStorage } from "node:async_hooks"

type TLifetimeCleanup = () => void | Promise<void>

/** Coordinates one idempotent shutdown across application-owned resources. */
export class Lifetime {
    readonly #controller = new AbortController()
    readonly #cleanups: TLifetimeCleanup[] = []
    readonly #closeStarted = Promise.withResolvers<void>()
    readonly #cleanupContext = new AsyncLocalStorage<boolean>()
    #closeTask: Promise<void> | undefined

    get signal(): AbortSignal {
        return this.#controller.signal
    }

    addCleanup(cleanup: TLifetimeCleanup): () => void {
        if (this.#closeTask) {
            throw new Error("Cannot register cleanup after shutdown has started")
        }
        this.#cleanups.push(cleanup)
        return () => {
            const index = this.#cleanups.indexOf(cleanup)
            if (index !== -1) this.#cleanups.splice(index, 1)
        }
    }

    close(reason: unknown = new Error("Buli is shutting down")): Promise<void> {
        if (this.#cleanupContext.getStore()) return Promise.resolve()
        if (this.#closeTask) return this.#closeTask

        const close = Promise.withResolvers<void>()
        const cleanups = [...this.#cleanups].reverse()
        this.#cleanups.length = 0
        this.#closeTask = close.promise
        this.#closeStarted.resolve()
        this.#controller.abort(reason)
        void this.runCleanups(cleanups).then(close.resolve, close.reject)
        return this.#closeTask
    }

    async waitForClose(): Promise<void> {
        if (this.#cleanupContext.getStore()) return
        await this.#closeStarted.promise
        await this.#closeTask
    }

    private async runCleanups(cleanups: readonly TLifetimeCleanup[]): Promise<void> {
        const errors: unknown[] = []
        for (const cleanup of cleanups) {
            try {
                await this.#cleanupContext.run(true, cleanup)
            } catch (error) {
                errors.push(error)
            }
        }
        if (errors.length > 0) {
            throw new AggregateError(errors, "Buli shutdown failed")
        }
    }
}
