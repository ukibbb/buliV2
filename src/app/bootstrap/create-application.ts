import { createBuliYoloAgentDefinition, createExplorerAgentDefinition } from "@/agent"
import { FilePromptCommands } from "@/app/prompt-commands"
import { realpath } from "node:fs/promises"
import { defaultModelPreferencesPath, loadModelPreferences, saveModelPreferences } from "@/app/preferences/model-preferences"
import { dirname, resolve } from "node:path"

import type {
    IAgentModel,
    IRuntimeAgentTool,
} from "@/agent"
import { createBuliAgentDefinition } from "@/agent/definitions/buli"
import type { IAuthenticationService } from "@/authentication"
import { NovibeAuth } from "@/app/novibe-auth/novibe-auth"
import open from "open"
import {
    createAuthentication,
    type IAuthenticationComposition,
} from "@/app/bootstrap/create-authentication"
import { createNovibeAgentDefinition } from "@/agent"
import {
    defaultUserInstructionsPath,
    loadInstructionFiles,
    loadSystemPromptFile,
} from "@/app/bootstrap/load-instruction-files"
import { createFdPathSearcher } from "@/app/path-search/fd-path-search"
import { ClaudeCodeHooks } from "@/hooks/claude-code-hooks"
import { loadClaudeSettings } from "@/hooks/claude-settings"
import { renderStatusLine } from "@/hooks/status-line"
import { connectConfiguredServers, type IConfiguredMcpTools, loadMcpConfig } from "@/mcp/configured-servers"
import { createInjectedModelComposition } from "@/app/bootstrap/model-composition"
import { createProviderModelComposition } from "@/app/bootstrap/create-provider-model-composition"
import type { IKimiModelCatalog } from "@/providers/kimi"
import type { IDeepSeekModelCatalog } from "@/providers/deepseek"
import type { IBuliApplication, IBuliModelSelection } from "@/app/contracts"
import { BuliApplicationRuntime } from "@/app/runtime"
import type { IOpenAiModelCatalog } from "@/providers/openai"
import {
    defaultHistoryDirectoryPath,
    type ISessionManager,
    SQLiteSessionManager,
} from "@/sessions"
import {
    EphemeralToolOutputStore,
} from "@/agent/tools"
import { version as applicationVersion } from "../../../package.json"

function defaultToolExecutablePaths() {
    if (process.env.BULI_DEVELOPMENT === "1") return {}
    const executableDirectory = resolve(
        dirname(process.execPath),
        "..",
        "lib",
        "buli",
    )
    return {
        fdExecutablePath: resolve(
            executableDirectory,
            process.platform === "win32" ? "fd.exe" : "fd",
        ),
        ripgrepExecutablePath: resolve(
            executableDirectory,
            process.platform === "win32" ? "rg.exe" : "rg",
        ),
    }
}

function defaultPathSearcher(workspaceRoot: string) {
    if (process.env.BULI_DEVELOPMENT === "1") {
        return createFdPathSearcher(workspaceRoot)
    }
    const executableName = process.platform === "win32" ? "fd.exe" : "fd"
    return createFdPathSearcher(workspaceRoot, {
        fallbackWhenMissing: true,
        executablePath: resolve(
            dirname(process.execPath),
            "..",
            "lib",
            "buli",
            executableName,
        ),
    })
}

export interface IBuliApplicationStartup {
    readonly runtime: IBuliApplication
    readonly authentication: IAuthenticationService
    readonly dispose: (reason?: unknown) => Promise<void>
}

export interface IBuliApplicationOptions {
    readonly signal: AbortSignal
    readonly workspaceRoot?: string
    readonly manager?: ISessionManager
    readonly model?: IAgentModel
    readonly tools?: readonly IRuntimeAgentTool[]
    // Startup owns injected services just like its defaults. Supplying a catalog
    // and auth transport also lets integration tests verify real registration and
    // SDK serialization without reading credentials or contacting an account.
    readonly authentication?: IAuthenticationComposition
    readonly modelCatalog?: IOpenAiModelCatalog
    readonly kimiModelCatalog?: IKimiModelCatalog
    readonly deepseekModelCatalog?: IDeepSeekModelCatalog
    readonly preferencesPath?: string
    readonly userInstructionsPath?: string
    /** File appended to Buli's system prompt, like Claude Code's `--append-system-prompt-file`. */
    readonly appendSystemPromptFile?: string
    /** Claude Code settings file whose command hooks Buli runs, like Claude Code's `--settings`. */
    readonly settingsPath?: string
    /** Claude Code `--mcp-config` file whose stdio servers' tools every Buli session gets. */
    readonly mcpConfigPath?: string
}

/** Composes provider, tools, persistence, sessions, and the UI boundary. */
export async function createBuliApplication(
    options: IBuliApplicationOptions,
): Promise<IBuliApplicationStartup> {
    // AbortSignal działa tylko z API, które go obsługuje, np. fetch. realpath nie:
    // pierwszy checkpoint blokuje start po abort, drugi zatrzymuje dalszy startup,
    // ale rozpoczętego realpath nie da się tu przerwać. Po aborcie rzucany jest reason.
    options.signal.throwIfAborted()
    const workspaceRoot: string = await realpath(
        options.workspaceRoot ?? process.cwd(),
    )
    options.signal.throwIfAborted()
    const instructionFiles = await loadInstructionFiles(
        workspaceRoot,
        options.userInstructionsPath ?? defaultUserInstructionsPath(),
        options.signal,
    )
    const appendedSystemPrompt = options.appendSystemPromptFile === undefined
        ? undefined
        : await loadSystemPromptFile(options.appendSystemPromptFile, options.signal)
    const settings = options.settingsPath === undefined
        ? undefined
        : await loadClaudeSettings(options.settingsPath, options.signal)
    // Like Claude Code: hooks, MCP servers and Bash inherit the settings `env` (e.g. buliOS memory role).
    if (settings) Object.assign(process.env, settings.env)
    const statusLine = settings?.statusLine
    const mcpServers = options.mcpConfigPath === undefined ? [] : await loadMcpConfig(options.mcpConfigPath, options.signal)

    const auth = options.authentication ?? createAuthentication()
    const authentication = auth.service
    const toolOutputStore = new EphemeralToolOutputStore()
    // Od tego miejsca startup posiada auth. Jeśli późniejszy etap rzuci, rollback
    // nie zostawi częściowo utworzonej usługi bez właściciela.
    let runtime: BuliApplicationRuntime | undefined
    let manager: ISessionManager | undefined
    let configuredMcp: IConfiguredMcpTools | undefined
    try {
        configuredMcp = await connectConfiguredServers(mcpServers, { name: "buli", version: applicationVersion }, options.signal)
        const systemPromptAddition = [appendedSystemPrompt, configuredMcp.instructions].filter(Boolean).join("\n\n")
        manager = options.manager ?? new SQLiteSessionManager({
            directoryPath: defaultHistoryDirectoryPath(workspaceRoot),
        })
        const modelComposition = options.model === undefined
            ? createProviderModelComposition({
                auth,
                ...(options.modelCatalog === undefined
                    ? {}
                    : { openAiCatalog: options.modelCatalog }),
                ...(options.kimiModelCatalog === undefined ? {} : { kimiCatalog: options.kimiModelCatalog }),
                ...(options.deepseekModelCatalog === undefined ? {} : { deepseekCatalog: options.deepseekModelCatalog }),
                includeWebSearch: options.tools === undefined,
            })
            : createInjectedModelComposition(options.model)
        const agentDependencies = {
            workspaceRoot,
            toolOutputStore,
            instructionFiles,
            ...(systemPromptAddition ? { appendedSystemPrompt: systemPromptAddition } : {}),
            ...defaultToolExecutablePaths(),
        }
        const agentOptions = {
            ...(options.tools === undefined ? {} : { tools: options.tools }),
            additionalTools: [...modelComposition.additionalTools, ...configuredMcp.tools],
        }
        const buli = createBuliAgentDefinition(agentDependencies, agentOptions)
        const yolo = createBuliYoloAgentDefinition(agentDependencies, agentOptions)

        const novibe = createNovibeAgentDefinition({
            workspaceRoot,
            toolOutputStore,
            ...defaultToolExecutablePaths(),
        }, modelComposition.additionalTools)

        const preferencesPath = options.preferencesPath ?? defaultModelPreferencesPath()
        const preferences = options.model === undefined ? loadModelPreferences(preferencesPath) : {}
        const applicationRuntime = new BuliApplicationRuntime({
            novibeAuth: new NovibeAuth(),
            openNovibeUrl: (url) => open(url),
            ...(preferences.selection === undefined ? {} : { restoredSelection: preferences.selection }),
            ...(preferences.warning === undefined ? {} : { preferencesWarning: preferences.warning }),
            ...(options.model === undefined ? {
                saveModelSelection: (selection: IBuliModelSelection) => saveModelPreferences(preferencesPath, selection),
            } : {}),
            workspaceRoot,
            manager,
            promptCommands: new FilePromptCommands(),
            agents: [buli, yolo, novibe],
            explorer: createExplorerAgentDefinition({
                workspaceRoot, toolOutputStore,
                instructionFiles,
                ...defaultToolExecutablePaths(),
            }),
            defaultAgentId: buli.id,
            models: modelComposition.models,
            selection: modelComposition.selection,
            searchPaths: defaultPathSearcher(workspaceRoot),
            toolOutputStore,
            ...(settings === undefined ? {} : {
                createSessionHooks: (sessionId: string) => new ClaudeCodeHooks({ sessionId, workspaceRoot, hooks: settings.hooks }),
            }),
            ...(statusLine === undefined ? {} : {
                renderStatusLine: (session, signal) => renderStatusLine(statusLine, session, { cwd: workspaceRoot, signal }),
            }),
            ...(modelComposition.discovery ?? {}),
        })
        runtime = applicationRuntime

        let disposePromise: Promise<void> | undefined
        let removeAbortListener: (() => void) | undefined

        const dispose = (
            reason: unknown = abortError("Buli application is shutting down"),
        ): Promise<void> => {
            if (disposePromise) return disposePromise

            const completion = Promise.withResolvers<void>()
            disposePromise = completion.promise

            removeAbortListener?.()
            removeAbortListener = undefined

            void disposeApplicationResources(
                applicationRuntime,
                authentication,
                configuredMcp,
                reason,
            ).then(
                completion.resolve,
                completion.reject,
            )
            return disposePromise
        }

        const disposeOnAbort = (): void => {
            void dispose(options.signal.reason).catch(() => { })
        }
        options.signal.addEventListener("abort", disposeOnAbort, { once: true })
        removeAbortListener = () => {
            options.signal.removeEventListener("abort", disposeOnAbort)
        }
        if (options.signal.aborted) disposeOnAbort()

        if (modelComposition.discovery !== undefined && !options.signal.aborted) {
            // Resolve account availability before exposing the first prompt editor:
            // otherwise its first run could silently capture Standard instead of
            // the preferred Fast adapter. The runtime records discovery failures
            // and blocks generation, but startup still opens the login/model UI.
            await applicationRuntime.refreshModels(options.signal).catch(() => { })
        }
        options.signal.throwIfAborted()

        return { runtime: applicationRuntime, authentication, dispose }
    } catch (startupError) {
        const rollbackResults = await Promise.allSettled([

            runtime?.dispose() ?? Promise.all([
                manager?.dispose?.(),
                toolOutputStore.dispose(),
            ]).then(() => undefined),
            authentication.dispose(startupError),
            configuredMcp?.close(),
        ])
        const rollbackErrors = rollbackResults.flatMap((result) =>
            result.status === "rejected" ? [result.reason] : []
        )
        if (rollbackErrors.length > 0) {
            throw new AggregateError(
                [startupError, ...rollbackErrors],
                "Buli startup rollback failed",
            )
        }
        throw startupError
    }
}

async function disposeApplicationResources(
    runtime: IBuliApplication,
    authentication: IAuthenticationService,
    configuredMcp: IConfiguredMcpTools | undefined,
    reason: unknown,
): Promise<void> {
    const results = await Promise.allSettled([
        runtime.dispose(),
        authentication.dispose(reason),
        configuredMcp?.close(),
    ])
    const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : []
    )
    if (errors.length > 0) {
        throw new AggregateError(errors, "Buli application shutdown failed")
    }
}

function abortError(message: string): Error {
    const error = new Error(message)
    error.name = "AbortError"
    return error
}
