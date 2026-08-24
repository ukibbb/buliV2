import type { TBuliCommand } from "@/app/ui/commands/types"

/** Defines the commands available to the connected application UI. */
export const BULI_COMMANDS: readonly TBuliCommand[] = [
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
        name: "model",
        description: "Select the model used for new prompts",
        loadingMessage: "Loading models...",
        load: async ({ application }, signal) => {
            let refreshError: string | undefined
            try {
                await application.refreshModels(signal)
            } catch (error) {
                signal.throwIfAborted()
                refreshError = commandErrorMessage(error)
            }
            const snapshot = application.getSnapshot()

            return {
                items: snapshot.models.map((model) => ({
                    id: model.id,
                    label: model.name,
                    description: model.id,
                })),
                selectedItemId: snapshot.selection.modelId,
                ...(refreshError === undefined
                    ? {}
                    : {
                        errorMessage:
                            `Model catalog refresh failed: ${refreshError}`,
                    }),
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

function commandErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
