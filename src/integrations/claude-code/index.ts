import type { IAgentHooks, IInstructionFile, IRuntimeAgentTool, ISubagentSpec } from "@/agent"
import type { TRenderStatusLine } from "@/common/status-line"
import type { IMcpClientInfo } from "@/mcp/mcp-connection"
import { loadClaudeAgents } from "@/integrations/claude-code/agents"
import { ClaudeCodeHooks } from "@/integrations/claude-code/hooks"
import {
    defaultUserInstructionsPath,
    loadClaudeInstructionFiles,
    loadSystemPromptFile,
} from "@/integrations/claude-code/instructions"
import { connectConfiguredServers, loadMcpConfig } from "@/integrations/claude-code/mcp-config"
import { loadClaudeSettings } from "@/integrations/claude-code/settings"
import { renderStatusLine } from "@/integrations/claude-code/status-line"

/** The Claude Code files Buli is pointed at, mirroring Claude Code's own flags. */
export interface IClaudeCodeConfig {
    /** Defaults to `~/.claude/CLAUDE.md`. */
    readonly userInstructionsPath?: string
    /** Appended to Buli's system prompt, like `--append-system-prompt-file`. */
    readonly appendSystemPromptFile?: string
    /** Settings whose command hooks, status line and `env` Buli uses, like `--settings`. */
    readonly settingsPath?: string
    /** Stdio MCP servers whose tools every Buli session gets, like `--mcp-config`. */
    readonly mcpConfigPath?: string
}

export interface IClaudeCodeIntegrationOptions extends IClaudeCodeConfig {
    /** Real path of the workspace. */
    readonly workspaceRoot: string
    readonly clientInfo: IMcpClientInfo
    readonly signal: AbortSignal
}

/** What Buli gets from the Claude Code configuration it shares with buliOS. */
export interface IClaudeCodeIntegration {
    /** User and workspace-root `CLAUDE.md` files, placed before Buli's own `.buli` instructions. */
    readonly instructionFiles: readonly IInstructionFile[]
    /** The appended system prompt file and MCP server instructions; empty when there are none. */
    readonly systemPromptAddition: string
    readonly tools: readonly IRuntimeAgentTool[]
    /** Agents from `~/.claude/agents`, run through `run_agent`. */
    readonly subagents: readonly ISubagentSpec[]
    readonly createSessionHooks: ((sessionId: string) => IAgentHooks) | undefined
    readonly renderStatusLine: TRenderStatusLine | undefined
    /** Stops the MCP server processes. */
    readonly close: () => Promise<void>
}

/**
 * Reads the Claude Code configuration Buli was pointed at and starts its MCP servers.
 * Like Claude Code, the settings `env` is exported to this process, so hooks, MCP servers
 * and Bash inherit it (for example the buliOS memory role).
 */
export async function createClaudeCodeIntegration(options: IClaudeCodeIntegrationOptions): Promise<IClaudeCodeIntegration> {
    const { workspaceRoot, signal } = options
    const instructionFiles = await loadClaudeInstructionFiles(
        workspaceRoot,
        options.userInstructionsPath ?? defaultUserInstructionsPath(),
        signal,
    )
    const appendedSystemPrompt = options.appendSystemPromptFile === undefined
        ? undefined
        : await loadSystemPromptFile(options.appendSystemPromptFile, signal)
    const settings = options.settingsPath === undefined ? undefined : await loadClaudeSettings(options.settingsPath, signal)
    if (settings) Object.assign(process.env, settings.env)
    const statusLine = settings?.statusLine
    const subagents = await loadClaudeAgents(signal)
    const mcpServers = options.mcpConfigPath === undefined ? [] : await loadMcpConfig(options.mcpConfigPath, signal)
    const mcp = await connectConfiguredServers(mcpServers, options.clientInfo, signal)

    return {
        instructionFiles,
        systemPromptAddition: [appendedSystemPrompt, mcp.instructions].filter(Boolean).join("\n\n"),
        tools: mcp.tools,
        subagents,
        createSessionHooks: settings && ((sessionId) => new ClaudeCodeHooks({ sessionId, workspaceRoot, hooks: settings.hooks })),
        renderStatusLine: statusLine && ((session, renderSignal) => renderStatusLine(statusLine, session, { cwd: workspaceRoot, signal: renderSignal })),
        close: mcp.close,
    }
}
