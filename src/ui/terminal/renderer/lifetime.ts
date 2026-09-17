import { AsyncLocalStorage } from "node:async_hooks"

// `void` pozwala na cleanup synchroniczny, a `Promise<void>` na asynchroniczny.
type TLifetimeCleanup = () => void | Promise<void>

/** Coordinates one idempotent shutdown across owned application resources. */
export class Lifetime {
    // Stan wynika z #closePromise: undefined = działa, pending = zamyka się,
    // fulfilled/rejected = zamknięte. Po starcie nie można dodać cleanupu.
    // `#` wymusza prywatność w runtime JS; `readonly` blokuje podmianę pola w TS.
    readonly #abortController = new AbortController()
    // Ostatnio zarejestrowany cleanup wykona się pierwszy; readonly nie zamraża tablicy.
    readonly #pendingCleanups: TLifetimeCleanup[] = []
    // withResolvers daje { promise, resolve, reject }; ten obiekt ogłasza start close().
    readonly #closeStarted = Promise.withResolvers<void>()
    // Odpowiednik Pythonowego contextvars.ContextVar, nie contextlib: `true` podąża
    // tylko za łańcuchem async cleanupu, również po await. Zwykły boolean objąłby
    // też równoległy, niezależny kod.
    readonly #cleanupExecutionContext = new AsyncLocalStorage<true>()
    // undefined przed close(), potem jeden wspólny Promise pełnego zamknięcia.
    #closePromise: Promise<void> | undefined

    // Odbiorca może obserwować anulowanie, ale bez kontrolera nie może go wywołać.
    get signal(): AbortSignal {
        return this.#abortController.signal
    }

    addCleanup(cleanup: TLifetimeCleanup): () => void {
        if (this.#closePromise) {
            throw new Error("Cannot register cleanup after shutdown has started")
        }
        this.#pendingCleanups.push(cleanup)

        // Zwrócona funkcja pamięta tę samą referencję i wyrejestrowuje ją przed close().
        return () => {
            const cleanupIndex = this.#pendingCleanups.indexOf(cleanup)
            // indexOf zwraca -1, gdy cleanupu już nie ma; splice usuwa jeden element.
            if (cleanupIndex !== -1) this.#pendingCleanups.splice(cleanupIndex, 1)
        }
    }

    // Metoda nie jest async, aby każde zewnętrzne wywołanie dostało ten sam Promise.
    close(reason: unknown = new Error("Buli is shutting down")): Promise<void> {
        // Bez tego cleanup może czekać na close(), które samo czeka na ten cleanup.
        if (this.#cleanupExecutionContext.getStore()) return Promise.resolve()
        // Pierwsze wywołanie ustala reason i wykonuje cleanupy; kolejne tylko czekają.
        if (this.#closePromise) return this.#closePromise

        const closeCompletion = Promise.withResolvers<void>()
        // Kopia zamraża plan, reverse daje LIFO, a wyzerowanie zwalnia rejestracje.
        const cleanupsToRun = [...this.#pendingCleanups].reverse()
        this.#pendingCleanups.length = 0

        // Publikacja przed callbackami chroni przed ponownym close() z listenera abort.
        this.#closePromise = closeCompletion.promise
        // resolve zmienia stan od razu; kod czekający przez await ruszy w microtasku.
        this.#closeStarted.resolve()

        // Jednorazowo ustawia aborted/reason i synchronicznie wywołuje listenery.
        // Nie zatrzyma kodu, który ignoruje signal, ani nie zaczeka na Promise listenera.
        this.#abortController.abort(reason)

        // then przenosi sukces/błąd cleanupów do publicznego Promise zamknięcia.
        // void tylko ignoruje dodatkowy Promise z then; nie anuluje ani nie tworzy wątku.
        void this.runCleanups(cleanupsToRun).then(
            closeCompletion.resolve,
            closeCompletion.reject,
        )

        return this.#closePromise
    }

    async waitForClose(): Promise<void> {
        // Chroni, gdy cleanup wywoła tę metodę bezpośrednio. Nie należy jednak
        // zwracać z cleanupu waitera utworzonego wcześniej: tworzyłby cykl Promise.
        if (this.#cleanupExecutionContext.getStore()) return
        // Pierwszy await czeka na start, drugi na cleanupy i propaguje ich błąd.
        await this.#closeStarted.promise
        // closePromise jest ustawione przed rozwiązaniem closeStarted.
        await this.#closePromise
    }

    // `private` sprawdza TypeScript; w przeciwieństwie do `#` nie chroni w runtime JS.
    private async runCleanups(cleanupsToRun: readonly TLifetimeCleanup[]): Promise<void> {
        const cleanupErrors: unknown[] = []
        for (const cleanup of cleanupsToRun) {
            try {
                // run oznacza tylko ten łańcuch async; await obsługuje void lub Promise
                // i kończy jeden cleanup przed rozpoczęciem następnego.
                await this.#cleanupExecutionContext.run(true, cleanup)
            } catch (error) {
                // Błąd nie pomija kolejnych cleanupów.
                cleanupErrors.push(error)
            }
        }
        if (cleanupErrors.length > 0) {
            throw new AggregateError(cleanupErrors, "Buli shutdown failed")
        }
    }
}
