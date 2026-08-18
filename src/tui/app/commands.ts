import type { IBuliApplication } from "@/application/contracts"
import type { TAuthenticationMode } from "@/tui/authentication/types"

export interface IBuliCommandInfo {
    readonly name: string
    readonly description: string
}

export interface IBuliCommandContext {
    readonly application: IBuliApplication
    readonly sessionId: string | null
    readonly activateSession: (sessionId: string) => void
    readonly goHome: () => void
    readonly openAuthentication: (mode: TAuthenticationMode) => void
}

export interface IBuliMenuItem {
    readonly id: string
    readonly label: string
    readonly description?: string
}

export interface IBuliPickerContent {
    readonly items: readonly IBuliMenuItem[]
    readonly selectedItemId?: string
    readonly emptyMessage?: string
}

type TBuliCommandHandler = (
    args: string,
    context: IBuliCommandContext,
) => void | Promise<void>

export type TBuliCommand = IBuliCommandInfo & (
    | {
        readonly kind: "action"
        readonly handler: TBuliCommandHandler
    }
    | {
        readonly kind: "picker"
        readonly load: (
            context: IBuliCommandContext,
        ) => IBuliPickerContent | Promise<IBuliPickerContent>
        readonly select: (
            itemId: string,
            context: IBuliCommandContext,
        ) => void | Promise<void>
    }
)

/** Declarative command catalog; the UI controller only owns invocation state. */
export const BULI_COMMANDS: readonly TBuliCommand[] = [
    {
        kind: "action",
        name: "clear",
        description: "Clear the current session",
        handler: (_args, context) => {
            if (context.sessionId) {
                context.application.clearSession(context.sessionId)
            }
        },
    },
    {
        kind: "picker",
        name: "model",
        description: "Select the model used for new prompts",
        load: ({ application }) => {
            const snapshot = application.getSnapshot()

            return {
                items: snapshot.models.map((model) => ({
                    id: model.id,
                    label: model.name,
                    description: model.id,
                })),
                selectedItemId: snapshot.selection.modelId,
            }
        },
        select: (modelId, { application }) => {
            application.selectModel(modelId)
        },
    },
    {
        kind: "picker",
        name: "reasoning",
        description: "Select the reasoning effort used for new prompts",
        load: ({ application }) => {
            const snapshot = application.getSnapshot()
            const model = snapshot.models.find(
                (candidate) => candidate.id === snapshot.selection.modelId,
            )
            if (!model) {
                throw new Error(`Unknown model: ${snapshot.selection.modelId}`)
            }

            return {
                items: model.reasoningEfforts.map((effort) => ({
                    id: effort,
                    label: effort,
                })),
                selectedItemId: snapshot.selection.reasoningEffort,
            }
        },
        select: (itemId, { application }) => {
            const snapshot = application.getSnapshot()
            const model = snapshot.models.find(
                (candidate) => candidate.id === snapshot.selection.modelId,
            )
            const effort = model?.reasoningEfforts.find(
                (candidate) => candidate === itemId,
            )
            if (!effort) {
                throw new Error(`Unsupported reasoning effort: ${itemId}`)
            }

            application.selectReasoningEffort(effort)
        },
    },
    {
        kind: "action",
        name: "new",
        description: "Start a new session",
        handler: (_args, context) => {
            context.goHome()
        },
    },
    {
        kind: "picker",
        name: "sessions",
        description: "Open a saved session",
        load: ({ application, sessionId }) => {
            const agents = new Map(
                application.getSnapshot().agents.map((agent) => [
                    agent.id,
                    agent.name,
                ]),
            )

            return {
                items: application.listSessions().map((session) => ({
                    id: session.id,
                    label: session.title,
                    description: [
                        shortSessionId(session.id),
                        agents.get(session.agentId) ?? session.agentId,
                        formatSessionTime(session.updatedAt),
                    ].join(" | "),
                })),
                ...(sessionId ? { selectedItemId: sessionId } : {}),
                emptyMessage: "No saved sessions",
            }
        },
        select: (sessionId, context) => {
            context.activateSession(sessionId)
        },
    },
    {
        kind: "action",
        name: "login",
        description: "Connect an authentication provider",
        handler: (_args, context) => {
            context.openAuthentication("login")
        },
    },
    {
        kind: "action",
        name: "logout",
        description: "Disconnect an authentication provider",
        handler: (_args, context) => {
            context.openAuthentication("logout")
        },
    },
    {
        kind: "action",
        name: "compact",
        description: "Summarize older context without deleting history",
        handler: async (_args, context) => {
            if (!context.sessionId) {
                throw new Error("Compaction requires an active session")
            }
            await context.application.compactSession(context.sessionId)
        },
    },
]

function shortSessionId(sessionId: string): string {
    return [...sessionId].slice(0, 8).join("")
}

function formatSessionTime(timestamp: number): string {
    const date = new Date(timestamp)
    if (Number.isNaN(date.getTime())) return String(timestamp)
    return date.toISOString().slice(0, 16).replace("T", " ")
}
