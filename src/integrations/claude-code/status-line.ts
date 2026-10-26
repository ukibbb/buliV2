import type { IStatusLineSession } from "@/common/status-line"
import type { IHookCommand } from "@/integrations/claude-code/settings"
import { runHookCommand } from "@/integrations/claude-code/hook-command"


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
