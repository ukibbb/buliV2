import type {
    IBuliApplication,
    ISnapshotSource,
} from "@/app/contracts"
import { BULI_YOLO_AGENT_ID } from "@/agent"
import { BULI_COMMANDS } from "@/ui/commands/builtin-commands"
import type {
    IBuliCommandContext,
    TBuliCommand,
} from "@/ui/commands/command-contracts"
import { CommandMenuController } from "@/ui/controller/command-menu-controller"
import {
    cloneUserInput,
    mergeUserInputs,
    sameUserInput,
    type IPathMention,
} from "@/ui/composer/prompt/prompt-draft"
import {
    BuliPromptSubmission,
    type TBuliInputDelivery,
    type TBuliInputSubmitResult,
} from "@/ui/controller/prompt-submission"
import {
    PathSuggestionsController,
    type IPathCompletion,
} from "@/ui/controller/path-suggestions-controller"
import {
    BuliUiStateStore,
    type IBuliUiSnapshot,
    type TBuliRoute,
} from "@/ui/controller/ui-state-store"
import type { TAuthenticationMode } from "@/ui/authentication"
import type {
    TUserInput,
    IUserInputContent,
} from "@/agent"

export type {
    IBuliCommandMenuSnapshot,
    IBuliPickerMenuSnapshot,
    IBuliPathMenuSnapshot,
    IBuliUiSnapshot,
    TBuliMenuSnapshot,
    TBuliRoute,
} from "@/ui/controller/ui-state-store"
export type {
    TBuliInputDelivery,
    TBuliInputSubmitResult,
} from "@/ui/controller/prompt-submission"

interface IBuliUiControllerOptions {
    readonly application: IBuliApplication
}

/** Coordinates application UI routing, input, menus, and async interactions. */
export class BuliUiController implements ISnapshotSource<IBuliUiSnapshot> {
    readonly workspaceRoot: string
    get commands(): readonly TBuliCommand[] {
        return [...BULI_COMMANDS, ...this.userCommands.map(command => ({
            kind: "prompt" as const, name: command.name, description: command.prompt.split("\n")[0] ?? "Saved prompt", prompt: command.prompt,
        }))]
    }

    private userCommands: readonly import("@/app/contracts").IUserPromptCommand[] = []

    private readonly application: IBuliApplication
    private readonly store = new BuliUiStateStore()
    private readonly commandMenu: CommandMenuController
    private readonly pathMenu: PathSuggestionsController
    private readonly inputSubmission: BuliPromptSubmission
    private inputDraft: IUserInputContent = { text: "" }
    private navigationPending = false
    private agentChangePending = false

    constructor(options: IBuliUiControllerOptions) {
        this.application = options.application
        this.workspaceRoot = options.application.workspaceRoot
        try { this.userCommands = this.loadUserCommands() } catch (error) { this.store.setInputError(error) }
        this.commandMenu = new CommandMenuController({
            store: this.store,
            commands: () => this.commands,
            commandContext: this.commandContext,
            submitPromptCommand: (text) => this.submitInput(text),
        })
        this.pathMenu = new PathSuggestionsController({
            application: this.application,
            store: this.store,
        })
        this.inputSubmission = new BuliPromptSubmission({
            application: this.application,
            store: this.store,
            commands: () => this.commands,
            activeSessionId: this.activeSessionId,
            executeCommand: this.commandMenu.executeCommand,
            consumeInput: this.consumeInputDraft,
        })
    }

    private loadUserCommands() {
        return (this.application.promptCommands?.list() ?? []).filter(command => !BULI_COMMANDS.some(builtin => builtin.name === command.name))
    }

    readonly openCommands = (): void => {
        try {
            if (!this.application.promptCommands) throw new Error("Prompt command storage is unavailable")
            this.userCommands = this.loadUserCommands()
            this.showCommandList()
        } catch (error) { this.store.setInputError(error) }
    }

    readonly closeCommands = (): void => {
        this.store.setSnapshot({ ...this.store.getSnapshot(), commandPanel: null })
    }

    readonly showAddCommand = (): void => {
        this.store.setSnapshot({ ...this.store.getSnapshot(), commandPanel: { mode: "add", commands: this.userCommands, error: null } })
    }

    readonly saveCommand = (name: string, prompt: string): boolean => {
        try {
            if (!this.application.promptCommands) throw new Error("Prompt command storage is unavailable")
            const normalizedName = name.trim().replace(/^\//, "")
            if (BULI_COMMANDS.some(command => command.name === normalizedName)) throw new Error(`Command /${normalizedName} is built in`)
            this.application.promptCommands.add({ name: normalizedName, prompt })
            this.userCommands = [...this.userCommands, { name: normalizedName, prompt }].sort((left, right) => left.name.localeCompare(right.name))
            this.showCommandList()
            return true
        } catch (error) { this.setCommandError(error); return false }
    }

    readonly removeCommand = (name: string): void => {
        try {
            if (!this.application.promptCommands) throw new Error("Prompt command storage is unavailable")
            this.application.promptCommands.remove(name)
            this.userCommands = this.userCommands.filter(command => command.name !== name)
            this.showCommandList()
        } catch (error) { this.setCommandError(error) }
    }

    private showCommandList(): void {
        this.store.setSnapshot({ ...this.store.getSnapshot(), menu: null, commandPanel: { mode: "list", commands: this.userCommands, error: null } })
    }

    private setCommandError(error: unknown): void {
        const snapshot = this.store.getSnapshot()
        if (!snapshot.commandPanel) return
        this.store.setSnapshot({ ...snapshot, commandPanel: { ...snapshot.commandPanel, error: error instanceof Error ? error.message : String(error) } })
    }

    readonly getSnapshot = (): IBuliUiSnapshot => this.store.getSnapshot()

    readonly subscribe = (listener: () => void): (() => void) => {
        return this.store.subscribe(listener)
    }

    readonly dispose = (): void => {
        this.commandMenu.cancelPendingLoad()
        this.pathMenu.cancel()
        this.store.dispose()
    }

    readonly toggleBuliAgent = async (): Promise<void> => {
        if (this.agentChangePending || this.navigationPending || this.store.isDisposed) return
        const sessionId = this.activeSessionId()
        this.agentChangePending = true
        try {
            if (sessionId) {
                await this.application.toggleBuliAgent(sessionId)
            } else {
                const session = this.application.createSession({ agentId: BULI_YOLO_AGENT_ID, title: "New conversation" })
                await this.activateSession(session.id)
            }
        } catch (error) {
            this.store.setInputError(error)
        } finally {
            this.agentChangePending = false
        }
    }

    readonly updateInput = (input: string): void => {
        this.updateDraft(
            { text: input },
            undefined,
        )
    }

    readonly getInputDraft = (): IUserInputContent => {
        const input = this.store.getSnapshot().input
        if (this.inputDraft.text !== input) this.inputDraft = { text: input }
        return this.inputDraft
    }

    readonly updateDraft = (
        input: IUserInputContent,
        mention?: IPathMention,
    ): void => {
        const snapshot = this.store.getSnapshot()
        if (
            sameUserInput(this.inputDraft, input)
            && !mention
            && snapshot.menu?.mode !== "paths"
        ) return
        this.inputDraft = cloneUserInput(input)
        this.commandMenu.cancelPendingLoad()
        if (this.pathMenu.updateInput(input.text, mention)) return
        this.commandMenu.updateInput(input.text)
    }

    readonly moveMenuSelection = (direction: -1 | 1): void => {
        this.commandMenu.moveSelection(direction)
    }

    readonly activateSelectedMenuItem = (): Promise<IPathCompletion | void> => {
        if (this.navigationPending) {
            this.store.setInputError(new Error("Session navigation is still pending"))
            return Promise.resolve()
        }
        if (this.store.getSnapshot().menu?.mode === "paths") {
            return Promise.resolve(this.pathMenu.activateSelectedItem())
        }
        return this.commandMenu.activateSelectedItem()
    }

    readonly submitInput = (
        input: TUserInput,
        delivery: TBuliInputDelivery = "auto",
    ): Promise<TBuliInputSubmitResult> => {
        if (this.navigationPending) {
            this.store.setInputError(new Error("Session navigation is still pending"))
            return Promise.resolve("retained")
        }
        this.pathMenu.cancel()
        this.commandMenu.cancelPendingLoad()
        return this.inputSubmission.submit(
            typeof input === "string" ? { text: input } : input,
            delivery,
        )
    }

    readonly setExternalUiError = (error: unknown): void => {
        if (this.store.isDisposed) return
        this.store.setInputError(error)
    }

    readonly dismissMenu = (): void => {
        if (this.store.isDisposed || this.store.getSnapshot().menu === null) return
        this.commandMenu.cancelPendingLoad()
        this.pathMenu.cancel()
        this.store.setMenu(null)
    }

    readonly escape = (): void => {
        if (this.store.isDisposed) return
        const snapshot = this.store.getSnapshot()

        if (snapshot.commandPanel) {
            if (snapshot.commandPanel.mode === "add") this.openCommands()
            else this.closeCommands()
            return
        }

        if (snapshot.authenticationMode) {
            this.closeAuthentication()
            return
        }

        if (snapshot.menu) {
            this.dismissMenu()
            return
        }

        const sessionId = this.activeSessionId()
        if (!sessionId) return

        try {
            const queued = this.application.clearQueuedMessages(sessionId)
            if (queued.steering.length > 0 || queued.followUp.length > 0) {
                const input = mergeUserInputs([
                    ...queued.steering,
                    ...queued.followUp,
                    this.getInputDraft(),
                ])
                this.inputDraft = input
                this.store.setSnapshot({
                    ...this.store.getSnapshot(),
                    input: input.text,
                    inputError: null,
                })
            }
        } catch (error) {
            this.store.setInputError(error)
        }

        void this.application.abort(sessionId).catch((error: unknown) => {
            this.store.setInputError(error)
        })
    }

    readonly goHome = (): Promise<void> => {
        return this.changeRoute({ type: "home" })
    }

    readonly openAuthentication = (mode: TAuthenticationMode): void => {
        if (this.store.isDisposed) return
        this.commandMenu.cancelPendingLoad()
        this.pathMenu.cancel()
        this.store.setSnapshot({
            ...this.store.getSnapshot(),
            authenticationMode: mode,
            menu: null,
            inputError: null,
        })
    }

    readonly closeAuthentication = (): void => {
        if (this.store.isDisposed) return
        const snapshot = this.store.getSnapshot()
        if (!snapshot.authenticationMode) return
        this.store.setSnapshot({
            ...snapshot,
            authenticationMode: null,
        })
    }

    readonly activateSession = (sessionId: string): Promise<void> => {
        return this.changeRoute({ type: "session", sessionId })
    }

    private async changeRoute(route: TBuliRoute): Promise<void> {
        if (this.store.isDisposed) return
        if (this.navigationPending) {
            throw new Error("Session navigation is still pending")
        }
        this.commandMenu.cancelPendingLoad()
        this.pathMenu.cancel()
        const previousSessionId = this.activeSessionId()
        const nextSessionId = route.type === "session" ? route.sessionId : null
        if (previousSessionId === nextSessionId) {
            this.store.setMenu(null)
            return
        }

        this.assertCanSwitchSession()
        this.navigationPending = true
        try {
            if (nextSessionId !== null) this.application.openSession(nextSessionId)
            this.store.setSnapshot({
                ...this.store.getSnapshot(),
                route,
                menu: null,
                inputError: null,
            })
            if (previousSessionId !== null) {
                try {
                    await this.application.closeSession(previousSessionId)
                } catch (error) {
                    const reason = error instanceof Error ? error.message : String(error)
                    this.store.setInputError(new Error(
                        `Failed to close previous session ${previousSessionId}: ${reason}`,
                    ))
                }
            }
        } finally {
            this.navigationPending = false
        }
    }

    private readonly activeSessionId = (): string | null => {
        const route = this.store.getSnapshot().route
        return route.type === "session" ? route.sessionId : null
    }

    private readonly consumeInputDraft = (input: IUserInputContent): void => {
        if (!sameUserInput(this.inputDraft, input)) return
        this.inputDraft = { text: "" }
        this.store.consumeInput(input.text)
    }

    private readonly commandContext = (): IBuliCommandContext => ({
        application: this.application,
        sessionId: this.activeSessionId(),
        activateSession: this.activateSession,
        goHome: this.goHome,
        openAuthentication: this.openAuthentication,
        openCommands: this.openCommands,
    })

    private assertCanSwitchSession(): void {
        const sessionId = this.activeSessionId()
        if (!sessionId) return

        const session = this.application.openSession(sessionId).getSnapshot()
        if (session.isRunning) {
            throw new Error("Cannot switch sessions while the current session is running")
        }
        if (session.isCompacting) {
            throw new Error("Cannot switch sessions while the current session is compacting")
        }
    }
}
