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

    constructor(options: IBuliCommandMenuOptions) {
        this.store = options.store
        this.commands = options.commands
        this.commandContext = options.commandContext
    }

    readonly updateInput = (input: string): void => {
        if (this.store.isDisposed) return

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
        if (command.kind === "action") {
            await command.handler(args, context)
            return true
        }

        const content = await command.load(context)
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
            errorMessage: null,
            ...(content.emptyMessage === undefined
                ? {}
                : { emptyMessage: content.emptyMessage }),
        })
        return true
    }

    private async activateSelectedItemOnce(): Promise<void> {
        const menu = this.store.getSnapshot().menu
        if (!menu) return

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
            await command.select(selected.id, this.commandContext())
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
