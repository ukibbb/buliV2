import type {
    IBuliApplication,
    IBuliPathSuggestion,
} from "@/app/contracts"
import type { IPathMention } from "@/app/ui/chat/prompt-draft"
import {
    BuliUiStateStore,
    errorMessage,
    type IBuliPathMenuItem,
} from "@/app/ui/controller/state"
import type { UserPathReference } from "@/agent"

const PATH_SEARCH_DEBOUNCE_MS = 20

export interface IPathCompletion {
    readonly triggerStart: number
    readonly triggerEnd: number
    readonly value: string
    readonly reference: Omit<UserPathReference, "source">
}

/** Owns cancellable fd completion and converts a selection into a path capability. */
export class BuliPathMenu {
    private readonly application: IBuliApplication
    private readonly store: BuliUiStateStore
    private generation = 0
    private activeSearch: AbortController | undefined
    private debounce: ReturnType<typeof setTimeout> | undefined
    private activeKey: string | undefined

    constructor(options: {
        readonly application: IBuliApplication
        readonly store: BuliUiStateStore
    }) {
        this.application = options.application
        this.store = options.store
    }

    updateInput(input: string, mention: IPathMention | undefined): boolean {
        if (!mention || this.store.isDisposed) {
            this.cancel()
            return false
        }

        const key = `${mention.start}:${mention.end}:${mention.query}`
        const snapshot = this.store.getSnapshot()
        if (key === this.activeKey && snapshot.menu?.mode === "paths") {
            if (snapshot.input !== input) {
                this.store.setSnapshot({ ...snapshot, input, inputError: null })
            }
            return true
        }

        this.cancel()
        this.activeKey = key
        const generation = this.generation
        this.store.setSnapshot({
            ...snapshot,
            input,
            inputError: null,
            menu: {
                mode: "paths",
                triggerStart: mention.start,
                triggerEnd: mention.end,
                items: [],
                selectedIndex: 0,
                emptyMessage: "Searching paths...",
                errorMessage: null,
            },
        })

        this.debounce = setTimeout(() => {
            this.debounce = undefined
            const controller = new AbortController()
            this.activeSearch = controller
            void (this.application.searchPaths?.(mention.query, controller.signal)
                ?? Promise.resolve([]))
                .then((suggestions) => {
                    if (
                        controller.signal.aborted
                        || generation !== this.generation
                        || this.store.isDisposed
                    ) return
                    const items = suggestions.map(pathMenuItem)
                    this.store.setMenu({
                        mode: "paths",
                        triggerStart: mention.start,
                        triggerEnd: mention.end,
                        items,
                        selectedIndex: 0,
                        ...(items.length === 0
                            ? { emptyMessage: "No matching paths" }
                            : {}),
                        errorMessage: null,
                    })
                })
                .catch((error: unknown) => {
                    if (
                        controller.signal.aborted
                        || generation !== this.generation
                        || this.store.isDisposed
                    ) return
                    this.store.setMenu({
                        mode: "paths",
                        triggerStart: mention.start,
                        triggerEnd: mention.end,
                        items: [],
                        selectedIndex: 0,
                        errorMessage: errorMessage(error),
                    })
                })
                .finally(() => {
                    if (this.activeSearch === controller) {
                        this.activeSearch = undefined
                    }
                })
        }, PATH_SEARCH_DEBOUNCE_MS)
        return true
    }

    activateSelectedItem(): IPathCompletion | undefined {
        const menu = this.store.getSnapshot().menu
        if (menu?.mode !== "paths") return undefined
        const selected = menu.items[menu.selectedIndex]
        if (!selected) return undefined
        this.cancel()
        this.store.setMenu(null)
        return {
            triggerStart: menu.triggerStart,
            triggerEnd: menu.triggerEnd,
            value: selected.value,
            reference: {
                type: "path",
                kind: selected.kind,
                path: selected.path,
            },
        }
    }

    cancel(): void {
        this.generation += 1
        this.activeKey = undefined
        if (this.debounce) clearTimeout(this.debounce)
        this.debounce = undefined
        this.activeSearch?.abort(abortError("Path search was cancelled"))
        this.activeSearch = undefined
    }
}

function pathMenuItem(suggestion: IBuliPathSuggestion): IBuliPathMenuItem {
    const display = suggestion.displayPath
        + (suggestion.kind === "directory" && suggestion.displayPath !== "."
            ? "/"
            : "")
    const quoted = /\s/.test(display)
    return {
        id: `${suggestion.kind}:${suggestion.path}`,
        label: display,
        description: suggestion.kind,
        kind: suggestion.kind,
        path: suggestion.path,
        displayPath: suggestion.displayPath,
        value: quoted ? `@"${display}"` : `@${display}`,
    }
}

function abortError(message: string): Error {
    const error = new Error(message)
    error.name = "AbortError"
    return error
}
