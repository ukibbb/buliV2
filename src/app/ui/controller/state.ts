import type { ISnapshotSource } from "@/app/contracts"
import type { IBuliMenuItem } from "@/app/ui/commands/types"
import type { TAuthenticationMode } from "@/authentication/ui"

interface IBuliMenuBase {
    readonly selectedIndex: number
    readonly errorMessage: string | null
    readonly items: readonly IBuliMenuItem[]
    readonly emptyMessage?: string
}

export interface IBuliCommandMenuSnapshot extends IBuliMenuBase {
    readonly mode: "commands"
}

export interface IBuliPickerMenuSnapshot extends IBuliMenuBase {
    readonly mode: "picker"
    readonly commandName: string
}

export type TBuliMenuSnapshot = IBuliCommandMenuSnapshot | IBuliPickerMenuSnapshot

export type TBuliRoute =
    | { readonly type: "home" }
    | { readonly type: "session"; readonly sessionId: string }

export interface IBuliUiSnapshot {
    readonly route: TBuliRoute
    readonly authenticationMode: TAuthenticationMode | null
    readonly menu: TBuliMenuSnapshot | null
    readonly input: string
    readonly inputError: string | null
}

type TUiListener = () => void

/** Owns the single observable snapshot mutated by all UI collaborators. */
export class BuliUiStateStore implements ISnapshotSource<IBuliUiSnapshot> {
    private readonly listeners = new Set<TUiListener>()
    private snapshot: IBuliUiSnapshot = {
        route: { type: "home" },
        authenticationMode: null,
        menu: null,
        input: "",
        inputError: null,
    }
    private disposed = false

    get isDisposed(): boolean {
        return this.disposed
    }

    readonly getSnapshot = (): IBuliUiSnapshot => this.snapshot

    readonly subscribe = (listener: TUiListener): (() => void) => {
        if (this.disposed) return () => {}
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
    }

    readonly dispose = (): void => {
        if (this.disposed) return
        this.disposed = true
        this.listeners.clear()
    }

    setSnapshot(snapshot: IBuliUiSnapshot): void {
        if (this.disposed) return
        this.snapshot = snapshot
        for (const listener of this.listeners) listener()
    }

    setMenu(menu: TBuliMenuSnapshot | null): void {
        if (!menu && !this.snapshot.menu) return
        this.setSnapshot({ ...this.snapshot, menu })
    }

    setInputError(error: unknown): void {
        this.setSnapshot({
            ...this.snapshot,
            inputError: errorMessage(error),
        })
    }

    consumeInput(submittedInput: string): void {
        if (this.snapshot.input !== submittedInput) return
        this.setSnapshot({
            ...this.snapshot,
            input: "",
            inputError: null,
        })
    }
}

/** Converts caught values into user-facing UI error text. */
export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
