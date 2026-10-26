import { readFile } from "node:fs/promises"

/** Claude Code hook events Buli runs; Stop and SessionEnd need a transcript Buli does not write yet. */
export const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse"] as const
export type THookEventName = typeof HOOK_EVENTS[number]

export interface IHookCommand {
    readonly command: string
    readonly timeoutSeconds?: number
}

/** One `hooks.<event>[]` entry: commands that run when the matcher fits. */
export interface IHookMatcherGroup {
    readonly matcher?: string
    readonly hooks: readonly IHookCommand[]
}

export type THookConfiguration = Readonly<Partial<Record<THookEventName, readonly IHookMatcherGroup[]>>>

/** The parts of a Claude Code settings file Buli runs. */
export interface IClaudeSettings {
    readonly hooks: THookConfiguration
    readonly statusLine?: IHookCommand
}

/** Reads command hooks and the status line from a Claude Code `settings.json`; other keys are ignored. */
export async function loadClaudeSettings(path: string, signal: AbortSignal): Promise<IClaudeSettings> {
    let settings: unknown
    try {
        settings = JSON.parse(await readFile(path, { encoding: "utf8", signal }))
    } catch (cause) {
        signal.throwIfAborted()
        throw new Error(`Unable to read settings: ${path}`, { cause })
    }
    if (!isRecord(settings)) throw new Error(`Settings must be a JSON object: ${path}`)

    const hooks: Partial<Record<THookEventName, readonly IHookMatcherGroup[]>> = {}
    const configured = isRecord(settings.hooks) ? settings.hooks : {}
    for (const event of HOOK_EVENTS) {
        const groups = configured[event]
        if (Array.isArray(groups)) hooks[event] = groups.flatMap(parseMatcherGroup)
    }
    const statusLine = parseCommand(settings.statusLine)
    return { hooks, ...(statusLine === undefined ? {} : { statusLine }) }
}

function parseMatcherGroup(value: unknown): IHookMatcherGroup[] {
    if (!isRecord(value) || !Array.isArray(value.hooks)) return []
    const hooks = value.hooks.flatMap((hook) => parseCommand(hook) ?? [])
    if (hooks.length === 0) return []
    return [{ ...(typeof value.matcher === "string" ? { matcher: value.matcher } : {}), hooks }]
}

/** Only `type: "command"` entries run; prompt and agent hooks are Claude Code features. */
function parseCommand(value: unknown): IHookCommand | undefined {
    if (!isRecord(value) || value.type !== "command" || typeof value.command !== "string") return undefined
    return {
        command: value.command,
        ...(typeof value.timeout === "number" && value.timeout > 0 ? { timeoutSeconds: value.timeout } : {}),
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}
