import type {
    IBuliApplication,
    ISnapshotSource,
} from "@/application/contracts"
import {
    BULI_COMMANDS,
    type IBuliCommandContext,
    type IBuliCommandInfo,
    type IBuliMenuItem,
} from "@/tui/app/commands"
import type { TAuthenticationMode } from "@/tui/authentication/types"

interface IBuliMenuBase {
    // Store the index of the currently highlighted item.
    readonly selectedIndex: number
    // Store the last selection error, or null when there is no error.
    readonly errorMessage: string | null
    // Store normalized rows so every menu can share navigation and rendering.
    readonly items: readonly IBuliMenuItem[]
    readonly emptyMessage?: string
}

export interface IBuliCommandMenuSnapshot extends IBuliMenuBase {
    // Mark this menu as a command list.
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
    // Store the currently visible menu variant, or null when no menu is open.
    readonly menu: TBuliMenuSnapshot | null
    readonly input: string
    readonly inputError: string | null
}

export type TBuliInputSubmitResult = "consumed" | "retained"
export type TBuliInputDelivery = "auto" | "followUp"

interface IBuliUiControllerOptions {
    readonly application: IBuliApplication
}

type TTuiListener = () => void

export class BuliUiController implements ISnapshotSource<IBuliUiSnapshot> {
    readonly workspaceRoot: string
    readonly commands: readonly IBuliCommandInfo[] = BULI_COMMANDS.map(
        ({ name, description }) => ({ name, description }),
    )

    private readonly application: IBuliApplication

    private readonly listeners = new Set<TTuiListener>()
    private inputSubmissionPending = false
    private menuActivationPending = false
    private disposed = false

    private snapshot: IBuliUiSnapshot = {
        route: { type: "home" },
        authenticationMode: null,
        menu: null,
        input: "",
        inputError: null,
    }

    constructor(options: IBuliUiControllerOptions) {
        this.application = options.application
        this.workspaceRoot = options.application.workspaceRoot
    }

    readonly getSnapshot = (): IBuliUiSnapshot => this.snapshot

    readonly subscribe = (listener: TTuiListener): (() => void) => {
        if (this.disposed) return () => {}
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
    }

    readonly dispose = (): void => {
        if (this.disposed) return
        // Zakończone później komendy mogą nadal domknąć własny Promise, ale nie
        // opublikują już snapshotu do odmontowanego drzewa React.
        this.disposed = true
        this.listeners.clear()
    }

    readonly updateInput = (input: string): void => {
        if (this.disposed) return
        if (
            input === ""
            && (
                this.snapshot.menu?.mode === "picker"
                || this.snapshot.menu?.errorMessage
            )
        ) {
            this.setSnapshot({
                ...this.snapshot,
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
        this.setSnapshot({
            ...this.snapshot,
            input,
            inputError: null,
            menu,
        })
    }

    readonly moveMenuSelection = (direction: -1 | 1): void => {
        if (this.disposed) return
        const menu = this.snapshot.menu
        // Read the currently active menu.

        if (!menu || menu.items.length === 0) return
        // Stop when there is no menu or no selectable item.

        const itemCount = menu.items.length
        // Read how many items the menu contains.

        let selectedIndex = menu.selectedIndex + direction
        // Move the index one position forward or backward.

        if (selectedIndex < 0) {
            selectedIndex = itemCount - 1
        }
        // Moving before the first item wraps to the last item.

        if (selectedIndex >= itemCount) {
            selectedIndex = 0
        }
        // Moving after the last item wraps to the first item.

        this.setMenu({ ...menu, selectedIndex, errorMessage: null })
        // Publish the new cursor position and clear an old selection error.
    }

    readonly activateSelectedMenuItem = async (): Promise<void> => {
        if (this.disposed || this.menuActivationPending) return
        this.menuActivationPending = true
        try {
            await this.activateSelectedMenuItemOnce()
        } finally {
            this.menuActivationPending = false
        }
    }

    private async activateSelectedMenuItemOnce(): Promise<void> {
        const menu = this.snapshot.menu
        // Read the currently active menu.

        if (!menu) return
        // Stop when there is no active menu.

        const selected = menu.items[menu.selectedIndex]
        // Read the highlighted menu item.

        if (!selected) return
        // Stop if the index does not point to an item.

        // Konsumujemy tylko tekst, który otworzył ten konkretny element menu.
        // Draft wpisany podczas oczekiwania na async command musi pozostać.
        const activatedInput = this.snapshot.input

        if (menu.mode === "commands") {
            try {
                await this.executeCommand(selected.id, "")
            } catch (error) {
                if (this.snapshot.menu === menu) {
                    this.setMenu({
                        ...menu,
                        errorMessage: errorMessage(error),
                    })
                }
                return
            }

            if (this.snapshot.menu === menu) this.setMenu(null)
            this.consumeInput(activatedInput)
            return
        }

        const command = BULI_COMMANDS.find(
            (candidate) => candidate.name === menu.commandName,
        )
        if (!command || command.kind !== "picker") {
            this.setMenu({
                ...menu,
                errorMessage: `Picker command is unavailable: ${menu.commandName}`,
            })
            return
        }

        try {
            await command.select(selected.id, {
                ...this.commandContext(),
            })
        } catch (error) {
            if (this.snapshot.menu === menu) {
                this.setMenu({
                    ...menu,
                    errorMessage: errorMessage(error),
                })
            }
            return
        }

        if (this.snapshot.menu === menu) this.setMenu(null)
        this.consumeInput(activatedInput)
    }

    readonly submitInput = async (
        input: string,
        delivery: TBuliInputDelivery = "auto",
    ): Promise<TBuliInputSubmitResult> => {
        if (this.disposed) return "retained"
        const text = input.trim()
        if (!text) return "retained"
        if (this.inputSubmissionPending) {
            this.setInputError(new Error("Prompt submission is still pending"))
            return "retained"
        }
        this.inputSubmissionPending = true
        try {
            return await this.submitInputOnce(input, text, delivery)
        } finally {
            this.inputSubmissionPending = false
        }
    }

    private async submitInputOnce(
        input: string,
        text: string,
        delivery: TBuliInputDelivery,
    ): Promise<TBuliInputSubmitResult> {

        this.setSnapshot({ ...this.snapshot, menu: null, inputError: null })

        const invocation = text.match(/^\/([^\s/]+)(?:\s+([\s\S]*))?$/)
        const name = invocation?.[1]
        const args = invocation?.[2] ?? ""
        const knownCommand = name
            ? this.commands.find((command) => command.name === name)
            : undefined

        if (knownCommand && args) {
            this.setInputError(new Error(`/${knownCommand.name} does not accept arguments`))
            return "retained"
        }

        if (name && !args) {
            try {
                if (await this.executeCommand(name, args)) {
                    this.consumeInput(input)
                    return "consumed"
                }
            } catch (error) {
                const command = this.commands.find(
                    (candidate) => candidate.name === name,
                )
                if (command) {
                    this.setMenu({
                        mode: "commands",
                        items: [{
                            id: command.name,
                            label: command.name,
                            description: command.description,
                        }],
                        selectedIndex: 0,
                        errorMessage: errorMessage(error),
                    })
                    this.consumeInput(input)
                    return "consumed"
                }
                this.setInputError(error)
                return "retained"
            }
        }

        try {
            const activeSessionId = this.activeSessionId()
            const activeSession = activeSessionId
                ? this.application.openSession(activeSessionId).getSnapshot()
                : undefined
            if (delivery === "followUp") {
                if (!activeSessionId || !activeSession?.isRunning) {
                    throw new Error("Follow-up requires an active run")
                }
                this.application.followUp(activeSessionId, text)
                this.consumeInput(input)
                return "consumed"
            }
            if (
                activeSessionId
                && activeSession?.isRunning
            ) {
                this.application.steer(activeSessionId, text)
                this.consumeInput(input)
                return "consumed"
            }
            const submission = this.application.submitPrompt({
                ...(activeSessionId ? { sessionId: activeSessionId } : {}),
                text,
            })
            void submission.settled.catch(() => {})
            await submission.accepted
            this.consumeInput(input)

            if (!activeSessionId && this.snapshot.route.type === "home") {
                this.setSnapshot({
                    ...this.snapshot,
                    route: { type: "session", sessionId: submission.sessionId },
                    menu: null,
                    inputError: null,
                })
            }
            return "consumed"
        } catch (error) {
            this.setInputError(error)
            return "retained"
        }
    }

    readonly escape = (): void => {
        if (this.disposed) return
        if (this.snapshot.authenticationMode) {
            this.closeAuthentication()
            return
        }

        if (this.snapshot.menu) {
            this.setMenu(null)
            const sessionId = this.activeSessionId()
            if (!sessionId) return
            const session = this.application.openSession(sessionId).getSnapshot()
            if (
                !session.isRunning
                && session.pendingSteeringMessages.length === 0
                && session.pendingFollowUpMessages.length === 0
            ) {
                return
            }
        }

        const sessionId = this.activeSessionId()
        if (sessionId) {
            try {
                const queued = this.application.clearQueuedMessages(sessionId)
                if (queued.steering.length > 0 || queued.followUp.length > 0) {
                    const input = [
                        ...queued.steering,
                        ...queued.followUp,
                        this.snapshot.input,
                    ]
                        .filter((text) => text.trim())
                        .join("\n\n")
                    this.setSnapshot({
                        ...this.snapshot,
                        input,
                        inputError: null,
                    })
                }
            } catch (error) {
                this.setInputError(error)
            }
            void this.application.abort(sessionId).catch((error: unknown) => {
                this.setInputError(error)
            })
        }
    }

    readonly goHome = (): void => {
        if (this.disposed) return
        if (this.snapshot.route.type === "home") {
            this.setMenu(null)
            return
        }

        this.assertCanSwitchSession()
        this.setSnapshot({
            ...this.snapshot,
            route: { type: "home" },
            menu: null,
            inputError: null,
        })
    }

    readonly openAuthentication = (mode: TAuthenticationMode): void => {
        if (this.disposed) return
        this.setSnapshot({
            ...this.snapshot,
            authenticationMode: mode,
            menu: null,
            inputError: null,
        })
    }

    readonly closeAuthentication = (): void => {
        if (this.disposed) return
        if (!this.snapshot.authenticationMode) return
        this.setSnapshot({
            ...this.snapshot,
            authenticationMode: null,
        })
    }

    readonly activateSession = (sessionId: string): void => {
        if (this.disposed) return
        if (
            this.snapshot.route.type === "session"
            && this.snapshot.route.sessionId === sessionId
        ) {
            this.setMenu(null)
            return
        }

        this.assertCanSwitchSession()
        this.application.openSession(sessionId)
        this.setSnapshot({
            ...this.snapshot,
            route: { type: "session", sessionId },
            menu: null,
            inputError: null,
        })
    }

    private async executeCommand(name: string, args: string): Promise<boolean> {
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

        this.setMenu({
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

    private setMenu(
        menu: TBuliMenuSnapshot | null,
    ): void {
        // Receive the complete next menu state.
        if (!menu && !this.snapshot.menu) return
        // Avoid publishing another identical closed state.

        this.setSnapshot({ ...this.snapshot, menu })
    }

    private activeSessionId(): string | null {
        return this.snapshot.route.type === "session"
            ? this.snapshot.route.sessionId
            : null
    }

    private commandContext(): IBuliCommandContext {
        return {
            application: this.application,
            sessionId: this.activeSessionId(),
            activateSession: this.activateSession,
            goHome: this.goHome,
            openAuthentication: this.openAuthentication,
        }
    }

    private assertCanSwitchSession(): void {
        const sessionId = this.activeSessionId()
        if (!sessionId) return

        if (this.application.openSession(sessionId).getSnapshot().isRunning) {
            throw new Error("Cannot switch sessions while the current session is running")
        }
    }

    private setSnapshot(snapshot: IBuliUiSnapshot): void {
        if (this.disposed) return
        this.snapshot = snapshot
        // Replace the UI snapshot with the new menu state.
        for (const listener of this.listeners) listener()
        // Notify React and other subscribers.
    }

    private setInputError(error: unknown): void {
        this.setSnapshot({
            ...this.snapshot,
            inputError: errorMessage(error),
        })
    }

    private consumeInput(submittedInput: string): void {
        if (this.snapshot.input !== submittedInput) return
        this.setSnapshot({
            ...this.snapshot,
            input: "",
            inputError: null,
        })
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
