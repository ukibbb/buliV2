import type { ReactNode } from "react"

import type {
    IToolCallContent,
    IToolResultMessage,
} from "@/agent"
import { glyphs, theme } from "@/ui/terminal/theme"

const TOOL_DETAIL_MAX_CHARACTERS = 160
const TOOL_NAME_MAX_CHARACTERS = 40
const TOOL_PARAMETER_VALUE_MAX_CHARACTERS = 96
const TOOL_TARGET_MAX_CHARACTERS = 96
// Persisted sessions can still contain calls to the removed handoff tool.
const LEGACY_PATCH_HANDOFF_TOOL_NAME = "request_patch_handoff"

interface IToolActivityLineProps {
    readonly call?: IToolCallContent
    readonly result?: IToolResultMessage
    readonly phase?: "pending" | "running"
}

/** Presents one evolving line for a tool call and its optional result. */
export function ToolActivityLine(props: IToolActivityLineProps): ReactNode {
    if (!props.call && !props.result) return null
    const toolName = props.call?.toolName ?? props.result?.toolName
    if (!toolName || toolName === LEGACY_PATCH_HANDOFF_TOOL_NAME) return null

    const presentation: IToolPresentation = props.call
        ? toolPresentation(props.call)
        : { name: displayToolName(toolName) }
    const state = activityState(props.result, props.phase)
    const name = compactText(
        singleLineTarget(presentation.name),
        TOOL_NAME_MAX_CHARACTERS,
    )
    const target = presentation.target
    const resultDetail = state.detail === undefined
        ? undefined
        : compactText(singleLineDetail(state.detail), TOOL_DETAIL_MAX_CHARACTERS)
    const detailParts = [presentation.parameters, resultDetail].filter(
        (value): value is string => value !== undefined && value.length > 0,
    )
    const detail = detailParts.length === 0 ? undefined : detailParts.join(" | ")

    return <text
        fg={state.critical ? theme.red : state.live ? theme.amber : theme.textMuted}
        minWidth={0}
        flexShrink={1}
        wrapMode="word"
        truncate={false}
    >
        <span fg={theme.text}>{name}</span>
        {target === undefined ? null : <>
            <span fg={state.live ? theme.amber : theme.textMuted}> [</span>
            <span fg={theme.textMuted}>{target}</span>
            <span fg={state.live ? theme.amber : theme.textMuted}>]</span>
        </>}
        {detail === undefined ? null : <span
            fg={state.critical ? theme.red : theme.textMuted}
        >{` ${detail}`}</span>}
        {state.marker === undefined
            ? null
            : <span fg={state.accent}>{` ${state.marker}`}</span>}
    </text>
}

interface IToolPresentation {
    readonly name: string
    // Targets are display-ready so structured inputs never need full serialization.
    readonly target?: string
    readonly parameters?: string
}

function toolPresentation(call: IToolCallContent): IToolPresentation {
    switch (call.toolName) {
        case "bash":
            return knownToolPresentation("Bash", call, "command", ["timeout"])
        case "read":
            return knownToolPresentation("Read", call, "path", [
                "offset",
                "limit",
            ])
        case "find":
            return knownToolPresentation("Find", call, "pattern", [
                "path",
                "limit",
            ])
        case "glob":
            return knownToolPresentation("Glob", call, "pattern", [
                "path",
                "hidden",
                "limit",
            ])
        case "grep":
            return knownToolPresentation("Grep", call, "pattern", [
                "path",
                "glob",
                "ignoreCase",
                "literal",
                "context",
                "limit",
            ])
        case "edit":
            return knownToolPresentation("Edit", call, "path", ["edits"])
        case "write":
            return knownToolPresentation("Write", call, "path", [])
        case "apply_patch":
            return knownToolPresentation("Apply patch", call, "explanation", ["changes"])
        case "tool_output":
            return knownToolPresentation("Tool output", call, "outputId", [
                "part",
                "encoding",
                "offset",
                "maxBytes",
                "maxLines",
            ])
        default:
            return {
                name: displayToolName(call.toolName),
                target: compactJson(call.input, TOOL_TARGET_MAX_CHARACTERS),
            }
    }
}

function knownToolPresentation(
    name: string,
    call: IToolCallContent,
    targetKey: string,
    parameterKeys: readonly string[],
): IToolPresentation {
    const target = call.input?.[targetKey]
    const parameters = toolParameters(call.input, parameterKeys)
    return {
        name,
        target: typeof target === "string"
            ? compactText(singleLineTarget(target), TOOL_TARGET_MAX_CHARACTERS)
            : compactJson(call.input, TOOL_TARGET_MAX_CHARACTERS),
        ...(parameters === undefined ? {} : { parameters }),
    }
}

function toolParameters(
    input: Readonly<Record<string, unknown>>,
    keys: readonly string[],
): string | undefined {
    const parameters = keys.flatMap((key) => {
        const value = input?.[key]
        if (value === undefined) return []
        const preview = typeof value === "string"
            ? compactText(
                singleLineTarget(value),
                TOOL_PARAMETER_VALUE_MAX_CHARACTERS,
            )
            : compactJson(value, TOOL_PARAMETER_VALUE_MAX_CHARACTERS)
        return [`${key}=${preview}`]
    })
    return parameters.length === 0 ? undefined : parameters.join(" ")
}

function displayToolName(toolName: string): string {
    switch (toolName) {
        case "bash": return "Bash"
        case "read": return "Read"
        case "find": return "Find"
        case "glob": return "Glob"
        case "grep": return "Grep"
        case "edit": return "Edit"
        case "write": return "Write"
        case "apply_patch": return "Apply patch"
        case "tool_output": return "Tool output"
        default: return toolName
    }
}

interface IToolActivityState {
    readonly live: boolean
    readonly critical: boolean
    readonly accent: string
    readonly detail?: string
    readonly marker?: string
}

function activityState(
    result: IToolResultMessage | undefined,
    phase: IToolActivityLineProps["phase"],
): IToolActivityState {
    if (!result) {
        return phase !== undefined
            ? { live: true, critical: false, accent: theme.amber }
            : {
                live: false,
                critical: true,
                accent: theme.red,
                marker: glyphs.failure,
            }
    }

    const outcome = result.outcome
    const critical = result.isError
        || outcome === "failed"
        || outcome === "committed-after-abort"
        || outcome === "effects-unknown"
    const detail = resultDetail(result)
    if (critical) {
        return {
            live: false,
            critical: true,
            accent: theme.red,
            ...(detail === undefined ? {} : { detail }),
            marker: glyphs.failure,
        }
    }
    if (outcome === "rejected" || outcome === "manual") {
        return {
            live: false,
            critical: false,
            accent: outcome === "manual" ? theme.amber : theme.textMuted,
            ...(detail === undefined ? {} : { detail }),
        }
    }
    return {
        live: false,
        critical: false,
        accent: theme.green,
        ...(detail === undefined ? {} : { detail }),
        marker: glyphs.success,
    }
}

function resultDetail(result: IToolResultMessage): string | undefined {
    // Keep join -> newline replacement -> trim: trimming each part loses separators
    // around whitespace-only summaries. Full detail normalization remains linear.
    const details = [
        result.summary,
        result.isError ? result.content : undefined,
    ].filter((value): value is string => value !== undefined && value.length > 0)
    return details.length > 0 ? details.join(" | ") : undefined
}

function* singleLineTarget(value: string): Generator<string> {
    for (const character of value) {
        switch (character) {
            case "\r": yield* "\\r"; break
            case "\n": yield* "\\n"; break
            case "\t": yield* "\\t"; break
            default: yield character
        }
    }
}

function singleLineDetail(value: string): string {
    return value.replace(/\r\n|\r|\n/g, " | ").trim()
}

/** Consumes code points, not graphemes or tokens; escaping happens upstream. */
function compactText(value: Iterable<string>, maximumCharacters: number): string {
    const characters: string[] = []
    for (const character of value) {
        characters.push(character)
        // One extra code point distinguishes exact fit from overflow. Returning here
        // also closes lazy generators before they visit the undisplayed suffix.
        if (characters.length > maximumCharacters) {
            if (maximumCharacters <= 3) return ".".repeat(Math.max(0, maximumCharacters))
            return `${characters.slice(0, maximumCharacters - 3).join("")}...`
        }
    }
    return characters.join("")
}

/**
 * Preview JSON scalars, arrays and plain records without conversion hooks.
 * Encountered cycles, unsupported values, failed reads and exhausted entry budgets
 * get a fixed diagnostic. Truncated previews need not be valid JSON; arbitrary
 * accessor/proxy code is not sandboxed.
 */
function compactJson(value: unknown, maximumCharacters: number): string {
    const ancestors = new Set<object>()
    // Omitted undefined/function/symbol fields emit nothing, so output alone does
    // not bound their traversal. This allowance also bounds recursive descent.
    let remainingEntries = maximumCharacters + 1

    function* characters(value: unknown): Generator<string> {
        if (typeof value === "string") {
            // Two UTF-16 units per code point, plus lookahead. If sliced, there is
            // enough text that the artificial closing quote cannot reach the preview.
            // Native quoting preserves control escapes and escapes lone surrogates.
            yield* JSON.stringify(value.slice(0, 2 * (maximumCharacters + 1)))
            return
        }
        if (value === null || typeof value === "boolean" || typeof value === "number") {
            yield* JSON.stringify(value)
            return
        }
        if (typeof value !== "object" || ancestors.has(value)) {
            throw new Error("Tool preview requires acyclic JSON data")
        }
        const array = Array.isArray(value)
        const prototype = Object.getPrototypeOf(value)
        if (!array && prototype !== Object.prototype && prototype !== null) {
            throw new Error("Tool preview requires JSON data objects")
        }
        ancestors.add(value)
        if (array) {
            yield "["
            const length = value.length
            for (let index = 0; index < length; index++) {
                if (remainingEntries-- <= 0) throw new Error("Tool preview entry limit")
                if (index > 0) yield ","
                const item: unknown = value[index]
                yield* characters(
                    item === undefined || typeof item === "function" || typeof item === "symbol"
                        ? null
                        : item,
                )
            }
            yield "]"
        } else {
            yield "{"
            let separator = ""
            // Avoid allocating Object.keys/entries. Engines may still enumerate all
            // keys internally: value reads are bounded, wide-object enumeration is not.
            for (const key in value) {
                if (remainingEntries-- <= 0) throw new Error("Tool preview entry limit")
                if (!Object.hasOwn(value, key)) continue
                const item = (value as Record<string, unknown>)[key]
                if (item === undefined || typeof item === "function" || typeof item === "symbol") {
                    continue
                }
                yield* separator
                yield* characters(key)
                yield ":"
                yield* characters(item)
                separator = ","
            }
            yield "}"
        }
        ancestors.delete(value)
    }

    try {
        return compactText(characters(value), maximumCharacters)
    } catch {
        return "[unserializable]"
    }
}
