import { BULI_COMMANDS } from "@/app/ui/commands/catalog"
import type {
    IBuliCommandContext,
    IBuliCommandInfo,
} from "@/app/ui/commands/types"
import {
    BuliUiStateStore,
    errorMessage,
    type TBuliMenuSnapshot,
} from "@/app/ui/controller/state"

interface IBuliCommandMenuOptions {
    readonly store: BuliUiStateStore
    readonly commands: readonly IBuliCommandInfo[]
    readonly commandContext: () => IBuliCommandContext
}

/** Owns slash suggestions, picker loading, selection, and menu activation. */
export class BuliCommandMenu {
    private readonly store: BuliUiStateStore
    private readonly commands: readonly IBuliCommandInfo[]
    private readonly commandContext: () => IBuliCommandContext
    private activationPending = false
    private loadGeneration = 0
    private activeLoad: AbortController | undefined

    constructor(options: IBuliCommandMenuOptions) {
        this.store = options.store
        this.commands = options.commands
        this.commandContext = options.commandContext
    }

    readonly updateInput = (input: string): void => {
        if (this.store.isDisposed) return
        this.cancelPendingLoad()

        const snapshot = this.store.getSnapshot()
        if (
            input === ""
            && (
                snapshot.menu?.mode === "picker"
                || snapshot.menu?.errorMessage
            )
        ) {
            this.store.setSnapshot({
                ...snapshot,
                input,
                inputError: null,
            })
            return
        }

        const query = input.match(/^\/([^\s/]*)$/)?.[1]
        const items = query === undefined
            ? []
            : this.commands
                .filter((command) =>
                    command.name.toLowerCase().startsWith(query.toLowerCase())
                )
                .map((command) => ({
                    id: command.name,
                    label: command.name,
                    description: command.description,
                }))
        const menu: TBuliMenuSnapshot | null = items.length > 0
            ? { mode: "commands", items, selectedIndex: 0, errorMessage: null }
            : null

        this.store.setSnapshot({
            ...snapshot,
            input,
            inputError: null,
            menu,
        })
    }

    readonly moveSelection = (direction: -1 | 1): void => {
        if (this.store.isDisposed) return
        const menu = this.store.getSnapshot().menu
        if (!menu || menu.items.length === 0) return

        const itemCount = menu.items.length
        let selectedIndex = menu.selectedIndex + direction
        if (selectedIndex < 0) selectedIndex = itemCount - 1
        if (selectedIndex >= itemCount) selectedIndex = 0

        this.store.setMenu({ ...menu, selectedIndex, errorMessage: null })
    }

    readonly cancelPendingLoad = (): void => {
        this.loadGeneration += 1
        this.activeLoad?.abort(abortError("Command load was cancelled"))
        this.activeLoad = undefined
    }

    readonly activateSelectedItem = async (): Promise<void> => {
        if (this.store.isDisposed || this.activationPending) return
        this.activationPending = true
        try {
            await this.activateSelectedItemOnce()
        } finally {
            this.activationPending = false
        }
    }

    readonly executeCommand = async (
        name: string,
        args: string,
    ): Promise<boolean> => {
        const command = BULI_COMMANDS.find((candidate) => candidate.name === name)
        if (!command) return false

        const context = this.commandContext()
        assertCommandsAllowed(context)
        if (command.kind === "action") {
            await command.handler(args, context)
            return true
        }

        this.cancelPendingLoad()
        const loadGeneration = this.loadGeneration
        const loadController = new AbortController()
        this.activeLoad = loadController
        if (command.loadingMessage) {
            this.store.setMenu({
                mode: "picker",
                commandName: command.name,
                items: [],
                selectedIndex: 0,
                emptyMessage: command.loadingMessage,
                errorMessage: null,
            })
        }
        let content
        try {
            content = await command.load(context, loadController.signal)
        } catch (error) {
            if (
                loadController.signal.aborted
                || loadGeneration !== this.loadGeneration
            ) {
                return true
            }
            throw error
        } finally {
            if (this.activeLoad === loadController) this.activeLoad = undefined
        }
        if (
            this.store.isDisposed
            || loadGeneration !== this.loadGeneration
        ) {
            return true
        }
        const selectedIndex = content.selectedItemId === undefined
            ? 0
            : content.items.findIndex(
                (item) => item.id === content.selectedItemId,
            )

        this.store.setMenu({
            mode: "picker",
            commandName: command.name,
            items: content.items,
            selectedIndex: selectedIndex >= 0 ? selectedIndex : 0,
            errorMessage: content.errorMessage ?? null,
            ...(content.emptyMessage === undefined
                ? {}
                : { emptyMessage: content.emptyMessage }),
        })
        return true
    }

    private async activateSelectedItemOnce(): Promise<void> {
        const menu = this.store.getSnapshot().menu
        if (!menu || menu.mode === "paths") return

        const selected = menu.items[menu.selectedIndex]
        if (!selected) return

        // Only consume the input that opened this item; preserve drafts typed
        // while an asynchronous command is still running.
        const activatedInput = this.store.getSnapshot().input

        if (menu.mode === "commands") {
            try {
                await this.executeCommand(selected.id, "")
            } catch (error) {
                if (this.store.getSnapshot().menu === menu) {
                    this.store.setMenu({
                        ...menu,
                        errorMessage: errorMessage(error),
                    })
                }
                return
            }

            if (this.store.getSnapshot().menu === menu) this.store.setMenu(null)
            this.store.consumeInput(activatedInput)
            return
        }

        const command = BULI_COMMANDS.find(
            (candidate) => candidate.name === menu.commandName,
        )
        if (!command || command.kind !== "picker") {
            this.store.setMenu({
                ...menu,
                errorMessage: `Picker command is unavailable: ${menu.commandName}`,
            })
            return
        }

        try {
            const context = this.commandContext()
            assertCommandsAllowed(context)
            await command.select(selected.id, context)
        } catch (error) {
            if (this.store.getSnapshot().menu === menu) {
                this.store.setMenu({
                    ...menu,
                    errorMessage: errorMessage(error),
                })
            }
            return
        }

        if (this.store.getSnapshot().menu === menu) this.store.setMenu(null)
        this.store.consumeInput(activatedInput)
    }
}

function assertCommandsAllowed(context: IBuliCommandContext): void {
    if (
        context.sessionId
        && context.application.openSession(context.sessionId)
            .getSnapshot().isCompacting
    ) {
        throw new Error("Cannot submit input while compacting the session")
    }
}

function abortError(message: string): Error {
    const error = new Error(message)
    error.name = "AbortError"
    return error
}
