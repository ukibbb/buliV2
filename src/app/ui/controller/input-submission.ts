import type { IBuliApplication } from "@/app/contracts"
import { trimUserInput } from "@/app/ui/chat/prompt-draft"
import type { IBuliCommandInfo } from "@/app/ui/commands/types"
import {
    BuliUiStateStore,
    errorMessage,
} from "@/app/ui/controller/state"
import type { IUserInput } from "@/agent"

export type TBuliInputSubmitResult = "consumed" | "retained"
export type TBuliInputDelivery = "auto" | "followUp"

interface IBuliInputSubmissionOptions {
    readonly application: IBuliApplication
    readonly store: BuliUiStateStore
    readonly commands: readonly IBuliCommandInfo[]
    readonly activeSessionId: () => string | null
    readonly executeCommand: (name: string, args: string) => Promise<boolean>
    readonly consumeInput: (input: IUserInput) => void
}

/** Parses and delivers commands, prompts, steering, and follow-up input. */
export class BuliInputSubmission {
    private readonly application: IBuliApplication
    private readonly store: BuliUiStateStore
    private readonly commands: readonly IBuliCommandInfo[]
    private readonly activeSessionId: () => string | null
    private readonly executeCommand: (
        name: string,
        args: string,
    ) => Promise<boolean>
    private readonly consumeInput: (input: IUserInput) => void
    private submissionPending = false

    constructor(options: IBuliInputSubmissionOptions) {
        this.application = options.application
        this.store = options.store
        this.commands = options.commands
        this.activeSessionId = options.activeSessionId
        this.executeCommand = options.executeCommand
        this.consumeInput = options.consumeInput
    }

    readonly submit = async (
        input: IUserInput,
        delivery: TBuliInputDelivery = "auto",
    ): Promise<TBuliInputSubmitResult> => {
        if (this.store.isDisposed) return "retained"
        const normalized = trimUserInput(input)
        if (!normalized.text && !normalized.attachments?.length) return "retained"
        if (this.submissionPending) {
            this.store.setInputError(new Error("Prompt submission is still pending"))
            return "retained"
        }

        this.submissionPending = true
        try {
            return await this.submitOnce(input, normalized, delivery)
        } finally {
            this.submissionPending = false
        }
    }

    private async submitOnce(
        input: IUserInput,
        normalized: IUserInput,
        delivery: TBuliInputDelivery,
    ): Promise<TBuliInputSubmitResult> {
        this.store.setSnapshot({
            ...this.store.getSnapshot(),
            menu: null,
            inputError: null,
        })
        const activeSessionId = this.activeSessionId()
        const activeSession = activeSessionId
            ? this.application.openSession(activeSessionId).getSnapshot()
            : undefined
        if (activeSession?.isCompacting) {
            this.store.setInputError(
                new Error("Cannot submit input while compacting the session"),
            )
            return "retained"
        }

        const invocation = !normalized.references?.length
            && !normalized.attachments?.length
            ? normalized.text.match(/^\/([^\s/]+)(?:\s+([\s\S]*))?$/)
            : null
        const name = invocation?.[1]
        const args = invocation?.[2] ?? ""
        const knownCommand = name
            ? this.commands.find((command) => command.name === name)
            : undefined

        if (knownCommand && args) {
            this.store.setInputError(
                new Error(`/${knownCommand.name} does not accept arguments`),
            )
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
                    this.store.setMenu({
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
                this.store.setInputError(error)
                return "retained"
            }
        }

        try {
            if (delivery === "followUp") {
                if (!activeSessionId || !activeSession?.isRunning) {
                    throw new Error("Follow-up requires an active run")
                }
                this.application.followUp(
                    activeSessionId,
                    normalized.text,
                    normalized,
                )
                this.consumeInput(input)
                return "consumed"
            }

            if (activeSessionId && activeSession?.isRunning) {
                this.application.steer(
                    activeSessionId,
                    normalized.text,
                    normalized,
                )
                this.consumeInput(input)
                return "consumed"
            }

            const submission = this.application.submitPrompt({
                ...(activeSessionId ? { sessionId: activeSessionId } : {}),
                ...normalized,
            })
            void submission.settled.catch(() => {})
            await submission.accepted
            this.consumeInput(input)

            if (
                !activeSessionId
                && this.store.getSnapshot().route.type === "home"
            ) {
                this.store.setSnapshot({
                    ...this.store.getSnapshot(),
                    route: { type: "session", sessionId: submission.sessionId },
                    menu: null,
                    inputError: null,
                })
            }
            return "consumed"
        } catch (error) {
            this.store.setInputError(error)
            return "retained"
        }
    }
}
