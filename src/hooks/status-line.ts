import type { IHookCommand } from "@/hooks/claude-settings"
import { runHookCommand } from "@/hooks/hook-command"

/** What Buli knows about the visible session when it draws the status line. */
export interface IStatusLineSession {
    readonly sessionId: string | undefined
    readonly modelId: string
    readonly modelName: string
    readonly inputTokens: number
    readonly contextWindowTokens: number | undefined
}

/** Runs Claude Code's `statusLine` command with its session JSON; undefined when the command fails. */
export async function renderStatusLine(
    command: IHookCommand,
    session: IStatusLineSession,
    options: { readonly cwd: string; readonly signal: AbortSignal },
): Promise<string | undefined> {
    const windowTokens = session.contextWindowTokens
    const result = await runHookCommand(command, {
        session_id: session.sessionId ?? "",
        cwd: options.cwd,
        model: { id: session.modelId, display_name: session.modelName },
        workspace: { current_dir: options.cwd, project_dir: options.cwd },
        context_window: {
            total_input_tokens: session.inputTokens,
            ...(windowTokens ? {
                context_window_size: windowTokens,
                used_percentage: Math.round((session.inputTokens / windowTokens) * 1000) / 10,
            } : {}),
        },
    }, options)
    return result.exitCode === 0 ? result.stdout : undefined
}
