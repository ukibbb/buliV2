import type {
    IBuliApplication,
    IBuliModelInfo,
    ISnapshotSource,
} from "@/application"
import type { TReasoningEffort } from "@/agent/agent-types"

export interface IBuliCommandInfo {
    readonly name: string
    readonly description: string
}

export interface IBuliCommandContext {
    readonly application: IBuliApplication
    readonly sessionId: string
}

export interface IBuliCommand extends IBuliCommandInfo {
    readonly handler: (
        args: string,
        context: IBuliCommandContext,
    ) => void | Promise<void>
}

export interface IBuliCommandMenuSnapshot {
    readonly items: readonly IBuliCommandInfo[]
    readonly selectedIndex: number
}

interface IBuliMenuBase {
    // store index of currently highlighted item
    readonly selectedIndex: number
    // store the last selection error, or null when there is no error
    readonly errorMessage: string | null
}

export type TBuliMenuSnapshot =
    | (IBuliMenuBase & {
        // mark this menu as a command list
        readonly mode: "commands"
        // store commands available to the user
        readonly items: readonly IBuliCommandInfo[]
    })
    | (IBuliMenuBase & {
        // mark this menu as the model picker
        readonly mode: "models"
        // store public model information without executable adapters
        readonly items: readonly IBuliModelInfo[]
    })
    | (IBuliMenuBase & {
        // mark this menu as reasoning effort picker
        readonly mode: "reasoning"
        // Store efforts supported by the currently selected model
        readonly items: readonly TReasoningEffort[]
    })

export interface IBuliUiSnapshot {
    readonly commandMenu: IBuliCommandMenuSnapshot | null
}

interface IBuliUiControllerOptions {
    readonly application: IBuliApplication
    readonly sessionId: string
}

type TTuiListener = () => void

// TODO(new-session): Add /new when activeSessionId becomes controller state.
// Generate a fresh ID and switch the UI without clearing the previous session.
// Add session discovery before supporting resume after restart.
export const BULI_COMMANDS = [
    {
        name: "clear",
        description: "Clear the current session",
        handler: (_args, context) => {
            context.application.clearSession(context.sessionId)
        },
    },
] satisfies readonly IBuliCommand[]

export class BuliUiController
    implements ISnapshotSource<IBuliUiSnapshot> {
    readonly sessionId: string
    readonly workspaceRoot: string
    readonly commands: readonly IBuliCommandInfo[] = BULI_COMMANDS.map(
        ({ name, description }) => ({ name, description }),
    )

    private readonly application: IBuliApplication
    private readonly listeners = new Set<TTuiListener>()
    private snapshot: IBuliUiSnapshot = { commandMenu: null }

    constructor(options: IBuliUiControllerOptions) {
        this.application = options.application
        this.sessionId = options.sessionId
        this.workspaceRoot = options.application.workspaceRoot
    }

    readonly getSnapshot = (): IBuliUiSnapshot => this.snapshot

    readonly subscribe = (listener: TTuiListener): (() => void) => {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
    }

    readonly updateInput = (input: string): void => {
        const query = input.match(/^\/([^\s/]*)$/)?.[1]
        if (query === undefined) {
            this.setCommandMenu(null)
            return
        }

        const normalizedQuery = query.toLowerCase()
        const items = this.commands.filter((command) =>
            command.name.toLowerCase().startsWith(normalizedQuery)
        )

        this.setCommandMenu(items.length > 0
            ? { items, selectedIndex: 0 }
            : null)
    }

    readonly moveCommandSelection = (direction: -1 | 1): void => {
        const menu = this.snapshot.commandMenu
        if (!menu) return

        const selectedIndex = (
            menu.selectedIndex
            + direction
            + menu.items.length
        ) % menu.items.length

        this.setCommandMenu({ ...menu, selectedIndex })
    }

    readonly executeSelectedCommand = async (): Promise<void> => {
        const menu = this.snapshot.commandMenu
        const selected = menu?.items[menu.selectedIndex]
        if (!selected) return

        this.setCommandMenu(null)
        await this.executeCommand(selected.name, "")
    }

    readonly submitInput = async (input: string): Promise<void> => {
        const text = input.trim()
        if (!text) return

        this.setCommandMenu(null)

        const invocation = text.match(/^\/([^\s/]+)(?:\s+([\s\S]*))?$/)
        const name = invocation?.[1]
        const args = invocation?.[2] ?? ""

        if (name && !args && await this.executeCommand(name, args)) return

        await this.application.submitPrompt({
            sessionId: this.sessionId,
            text,
        })
    }

    readonly escape = (): void => {
        if (this.snapshot.commandMenu) {
            this.setCommandMenu(null)
            return
        }

        this.application.abort(this.sessionId)
    }

    private async executeCommand(name: string, args: string): Promise<boolean> {
        const command = BULI_COMMANDS.find((candidate) => candidate.name === name)
        if (!command) return false

        await command.handler(args, {
            application: this.application,
            sessionId: this.sessionId,
        })
        return true
    }

    private setCommandMenu(
        commandMenu: IBuliCommandMenuSnapshot | null,
    ): void {
        if (!commandMenu && !this.snapshot.commandMenu) return

        this.snapshot = { commandMenu }
        for (const listener of this.listeners) listener()
    }
}
