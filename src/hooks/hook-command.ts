import type { IHookCommand } from "@/hooks/claude-settings"

/** Claude Code's default hook timeout. */
const DEFAULT_TIMEOUT_SECONDS = 60

export interface IHookCommandResult {
    /** Undefined when the command could not start, timed out, or was aborted. */
    readonly exitCode: number | undefined
    readonly stdout: string
    readonly stderr: string
}

const NOT_RUN: IHookCommandResult = { exitCode: undefined, stdout: "", stderr: "" }

/** Runs one hook through `sh -c` with its JSON input on stdin, killing it on timeout or abort. */
export async function runHookCommand(
    hook: IHookCommand,
    input: object,
    options: { readonly cwd: string; readonly signal: AbortSignal },
): Promise<IHookCommandResult> {
    const timeout = AbortSignal.timeout((hook.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000)
    const signal = AbortSignal.any([options.signal, timeout])
    if (signal.aborted) return NOT_RUN
    let child: Bun.Subprocess<"pipe", "pipe", "pipe">
    try {
        child = Bun.spawn(["sh", "-c", hook.command], {
            cwd: options.cwd,
            env: { ...process.env, CLAUDE_PROJECT_DIR: options.cwd },
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
        })
    } catch (error) {
        return { ...NOT_RUN, stderr: String(error) }
    }
    // A background process the hook started can keep the pipes open after the kill,
    // so an abort also stops waiting for the output.
    const stopped = Promise.withResolvers<undefined>()
    const onAbort = () => {
        child.kill()
        stopped.resolve(undefined)
    }
    signal.addEventListener("abort", onAbort, { once: true })
    try {
        try {
            child.stdin.write(JSON.stringify(input))
            await child.stdin.end()
        } catch {
            // A hook may exit without reading its input; its exit code still decides.
        }
        const finished = await Promise.race([
            Promise.all([
                new Response(child.stdout).text(),
                new Response(child.stderr).text(),
                child.exited,
            ]),
            stopped.promise,
        ])
        if (finished === undefined || signal.aborted) return NOT_RUN
        const [stdout, stderr, exitCode] = finished
        return { exitCode, stdout, stderr }
    } finally {
        signal.removeEventListener("abort", onAbort)
    }
}
