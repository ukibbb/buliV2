import type {
    IBuliApplication,
    ISnapshotSource,
} from "@/app/contracts"
import { BULI_COMMANDS } from "@/app/ui/commands/catalog"
import type {
    IBuliCommandContext,
    IBuliCommandInfo,
} from "@/app/ui/commands/types"
import { BuliCommandMenu } from "@/app/ui/controller/command-menu"
import {
    cloneUserInput,
    mergeUserInputs,
    sameUserInput,
    type IPathMention,
} from "@/app/ui/chat/prompt-draft"
import {
    BuliInputSubmission,
    type TBuliInputDelivery,
    type TBuliInputSubmitResult,
} from "@/app/ui/controller/input-submission"
import {
    BuliPathMenu,
    type IPathCompletion,
} from "@/app/ui/controller/path-menu"
import {
    BuliUiStateStore,
    type IBuliUiSnapshot,
} from "@/app/ui/controller/state"
import { BuliToolApproval } from "@/app/ui/controller/tool-approval"
import type { TAuthenticationMode } from "@/authentication/ui"
import type {
    ToolApprovalDecision,
    UserInput,
    UserInputContent,
} from "@/agent"

export type {
    IBuliCommandMenuSnapshot,
    IBuliPickerMenuSnapshot,
    IBuliPathMenuSnapshot,
    IBuliUiSnapshot,
    TBuliMenuSnapshot,
    TBuliRoute,
} from "@/app/ui/controller/state"
export type {
    TBuliInputDelivery,
    TBuliInputSubmitResult,
} from "@/app/ui/controller/input-submission"

interface IBuliUiControllerOptions {
    readonly application: IBuliApplication
}

/** Coordinates application UI routing, input, menus, and async interactions. */
export class BuliUiController implements ISnapshotSource<IBuliUiSnapshot> {
    readonly workspaceRoot: string
    readonly commands: readonly IBuliCommandInfo[]

    private readonly application: IBuliApplication
    private readonly store = new BuliUiStateStore()
    private readonly commandMenu: BuliCommandMenu
    private readonly pathMenu: BuliPathMenu
    private readonly inputSubmission: BuliInputSubmission
    private readonly toolApproval: BuliToolApproval
    private inputDraft: UserInputContent = { text: "" }

    constructor(options: IBuliUiControllerOptions) {
        this.application = options.application
        this.workspaceRoot = options.application.workspaceRoot
        this.commands = BULI_COMMANDS.map(
            ({ name, description }) => ({ name, description }),
        )
        this.commandMenu = new BuliCommandMenu({
            store: this.store,
            commands: this.commands,
            commandContext: this.commandContext,
        })
        this.pathMenu = new BuliPathMenu({
            application: this.application,
            store: this.store,
        })
        this.inputSubmission = new BuliInputSubmission({
            application: this.application,
            store: this.store,
            commands: this.commands,
            activeSessionId: this.activeSessionId,
            executeCommand: this.commandMenu.executeCommand,
            consumeInput: this.consumeInputDraft,
        })
        this.toolApproval = new BuliToolApproval({
            application: this.application,
            store: this.store,
            activeSessionId: this.activeSessionId,
        })
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

    readonly updateInput = (input: string): void => {
        this.updateDraft(
            { text: input },
            undefined,
        )
    }

    readonly getInputDraft = (): UserInputContent => {
        const input = this.store.getSnapshot().input
        if (this.inputDraft.text !== input) this.inputDraft = { text: input }
        return this.inputDraft
    }

    readonly updateDraft = (
        input: UserInputContent,
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
        if (this.store.getSnapshot().menu?.mode === "paths") {
            return Promise.resolve(this.pathMenu.activateSelectedItem())
        }
        return this.commandMenu.activateSelectedItem()
    }

    readonly submitInput = (
        input: UserInput,
        delivery: TBuliInputDelivery = "auto",
    ): Promise<TBuliInputSubmitResult> => {
        this.pathMenu.cancel()
        this.commandMenu.cancelPendingLoad()
        return this.inputSubmission.submit(
            typeof input === "string" ? { text: input } : input,
            delivery,
        )
    }

    readonly resolveToolApproval = (
        approvalId: string,
        decision: ToolApprovalDecision,
        beforeResolve?: () => boolean,
    ): void => {
        this.toolApproval.resolve(approvalId, decision, beforeResolve)
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

        if (snapshot.authenticationMode) {
            this.closeAuthentication()
            return
        }

        if (snapshot.menu) {
            this.commandMenu.cancelPendingLoad()
            this.pathMenu.cancel()
            this.store.setMenu(null)
            const sessionId = this.activeSessionId()
            if (!sessionId) return
            const session = this.application.openSession(sessionId).getSnapshot()
            if (
                !session.isRunning
                && !session.isCompacting
                && session.pendingSteeringMessages.length === 0
                && session.pendingFollowUpMessages.length === 0
            ) {
                return
            }
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

    readonly goHome = (): void => {
        if (this.store.isDisposed) return
        this.commandMenu.cancelPendingLoad()
        this.pathMenu.cancel()
        const snapshot = this.store.getSnapshot()
        if (snapshot.route.type === "home") {
            this.store.setMenu(null)
            return
        }

        this.assertCanSwitchSession()
        this.store.setSnapshot({
            ...this.store.getSnapshot(),
            route: { type: "home" },
            menu: null,
            inputError: null,
        })
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

    readonly activateSession = (sessionId: string): void => {
        if (this.store.isDisposed) return
        this.commandMenu.cancelPendingLoad()
        this.pathMenu.cancel()
        const snapshot = this.store.getSnapshot()
        if (
            snapshot.route.type === "session"
            && snapshot.route.sessionId === sessionId
        ) {
            this.store.setMenu(null)
            return
        }

        this.assertCanSwitchSession()
        this.application.openSession(sessionId)
        this.store.setSnapshot({
            ...this.store.getSnapshot(),
            route: { type: "session", sessionId },
            menu: null,
            inputError: null,
        })
    }

    private readonly activeSessionId = (): string | null => {
        const route = this.store.getSnapshot().route
        return route.type === "session" ? route.sessionId : null
    }

    private readonly consumeInputDraft = (input: UserInputContent): void => {
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
