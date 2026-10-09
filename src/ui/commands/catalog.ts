import type { TBuliCommand } from "@/ui/commands/types"

/** Defines the commands available to the connected application UI. */
export const BULI_COMMANDS: readonly TBuliCommand[] = [
    {
        kind: "action",
        name: "new",
        description: "Start a new session",
        handler: (args, context) => {
            assertNoArguments("new", args)
            return context.goHome()
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
            const providerErrors = snapshot.providerCatalogs?.filter((provider) => provider.status === "error")
                .map((provider) => `${provider.message ?? provider.providerId}${provider.stale ? " Using the previous catalog." : ""}`).join(" ")
            refreshError ??= providerErrors || undefined

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
            return context.activateSession(sessionId)
        },
    },
    {
        kind: "action",
        name: "login",
        description: "Connect an authentication provider",
        handler: (args, context) => {
            assertNoArguments("login", args)
            context.openAuthentication("login")
        },
    },
    {
        kind: "action",
        name: "logout",
        description: "Disconnect an authentication provider",
        handler: (args, context) => {
            assertNoArguments("logout", args)
            context.openAuthentication("logout")
        },
    },
    {
        kind: "action",
        name: "branch",
        description: "Start a read-only side conversation",
        handler: (args, { application, sessionId }) => {
            if (!sessionId) throw new Error("Branching requires an active session")
            if (args.trim()) throw new Error("Use /branch without arguments")
            application.createBranch(sessionId)
        },
    },
    {
        kind: "action",
        name: "return",
        description: "Return to the parent without transferring side messages",
        handler: (args, { application, sessionId }) => {
            if (!sessionId) throw new Error("Returning requires an active session")
            if (args.trim()) throw new Error("Use /return without arguments")
            application.returnToParentBranch(sessionId)
        },
    },
    {
        kind: "action",
        name: "compact",
        description: "Summarize older context without deleting history",
        handler: async (args, context) => {
            assertNoArguments("compact", args)
            if (!context.sessionId) {
                throw new Error("Compaction requires an active session")
            }
            await context.application.compactSession(context.sessionId)
        },
    },
    {
        kind: "action",
        name: "novibe",
        description: "NoVibe: przełącz agenta; off przywraca Buli; login, status, logout obsługują konto",
        handler: async (args, { application, sessionId, activateSession }) => {
            const argument = args.trim()
            if (argument === "login" || argument === "status" || argument === "logout") {
                if (!application.novibeAccount) throw new Error("NoVibe authentication is unavailable")
                return application.novibeAccount(argument, sessionId ?? undefined)
            }
            if (argument !== "" && argument !== "off") {
                throw new Error("Użyj /novibe, /novibe off, /novibe login, /novibe status albo /novibe logout.")
            }
            if (argument === "off") {
                return sessionId
                    ? application.deactivateNovibe(sessionId)
                    : "NoVibe nie jest aktywne."
            }
            if (sessionId) return application.activateNovibe(sessionId)

            const session = application.createSession({
                agentId: application.getSnapshot().defaultAgentId,
                title: "NoVibe",
            })
            await activateSession(session.id)
            return application.activateNovibe(session.id)
        },
    },
]

function assertNoArguments(name: string, args: string): void {
    if (args.trim()) throw new Error(`/${name} does not accept arguments`)
}

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
