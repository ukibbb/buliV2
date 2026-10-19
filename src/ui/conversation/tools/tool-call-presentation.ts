import type { IToolCallContent, IToolResultMessage } from "@/agent"
import { glyphs, theme } from "@/ui/terminal/theme"
import { compactText, compactJson, singleLineTarget } from "@/ui/conversation/tools/limited-value-preview"

const TOOL_DETAIL_MAX_CHARACTERS = 160
const TOOL_NAME_MAX_CHARACTERS = 40
const TOOL_PARAMETER_VALUE_MAX_CHARACTERS = 96
const TOOL_TARGET_MAX_CHARACTERS = 96
// Persisted sessions can still contain calls to the removed handoff tool.
const LEGACY_PATCH_HANDOFF_TOOL_NAME = "request_patch_handoff"

export interface IToolCallDisplayProps {
    readonly call?: IToolCallContent
    readonly result?: IToolResultMessage
    readonly phase?: "pending" | "running"
}

export interface IToolCallPresentation {
    readonly name: string
    readonly target: string | undefined
    readonly detail: string | undefined
    readonly foreground: string
    readonly accent: string
    readonly marker: string | undefined
    readonly diff: string | undefined
    readonly output?: string
}

/** Prepares display values without creating React elements. */
export function presentToolCall(props: IToolCallDisplayProps): IToolCallPresentation | undefined {
    if (!props.call && !props.result) return undefined
    const toolName = props.call?.toolName ?? props.result?.toolName
    if (!toolName || !isVisibleTool(toolName)) return undefined

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

    return {
        name, target, detail,
        foreground: state.critical ? theme.red : state.live ? theme.amber : theme.textSecondary,
        accent: state.accent, marker: state.marker, diff: props.result?.diff,
        ...(toolName === "bash" && props.result?.content ? { output: props.result.content } : {}),
    }
}

/** Hidden legacy calls must not introduce transcript spacing either. */
export function isVisibleTool(name: string): boolean {
    return Boolean(name) && name !== LEGACY_PATCH_HANDOFF_TOOL_NAME
}

interface IToolPresentation {
    readonly name: string
    // Targets are display-ready so structured inputs never need full serialization.
    readonly target?: string
    readonly parameters?: string
}

function toolPresentation(call: IToolCallContent): IToolPresentation {
    switch (call.toolName) {
        case "delegate_task":
            return { name: "Delegate tasks", target: `${Array.isArray(call.input.tasks) ? call.input.tasks.length : 0} zadań` }
        case "bash":
            return knownToolPresentation("Bash", call, "command", ["timeout"])
        case "read":
            return fullToolPresentation("Read", call, "path", [
                ["start line", call.input.offset],
                ["line limit", call.input.limit],
            ])
        case "find":
            return fullToolPresentation("Find", call, "pattern", [
                ["directory", call.input.path],
                ["result limit", call.input.limit],
            ])
        case "glob":
            return knownToolPresentation("Glob", call, "pattern", [
                "path",
                "hidden",
                "limit",
            ])
        case "grep":
            return fullToolPresentation("Grep", call, "pattern", [
                ["directory", call.input.path],
                ["files", call.input.glob],
                ["matching", typeof call.input.literal === "boolean"
                    ? call.input.literal ? "literal" : "regex"
                    : undefined],
                ["case", typeof call.input.ignoreCase === "boolean"
                    ? call.input.ignoreCase ? "insensitive" : "sensitive"
                    : undefined],
                ["context lines", call.input.context],
                ["result limit", call.input.limit],
            ])
        case "edit":
            return fullToolPresentation("Edit", call, "path", [
                ["replacements", Array.isArray(call.input.edits) ? call.input.edits.length : undefined],
            ])
        case "write":
            return fullToolPresentation("Write", call, "path", [])
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

/** Formats known operation arguments without truncating paths or search expressions. */
function fullToolPresentation(
    name: string,
    call: IToolCallContent,
    targetKey: string,
    parameters: readonly (readonly [label: string, value: unknown])[],
): IToolPresentation {
    const target = call.input[targetKey]
    const details = parameters.flatMap(([label, value]) => {
        if (value === undefined) return []
        const text = typeof value === "string"
            ? value.replaceAll("\r", "\\r").replaceAll("\n", "\\n").replaceAll("\t", "\\t")
            : compactJson(value, TOOL_PARAMETER_VALUE_MAX_CHARACTERS)
        return [`${label}=${text}`]
    })
    return {
        name,
        target: typeof target === "string"
            ? target.replaceAll("\r", "\\r").replaceAll("\n", "\\n").replaceAll("\t", "\\t")
            : compactJson(call.input, TOOL_TARGET_MAX_CHARACTERS),
        ...(details.length === 0 ? {} : { parameters: details.join(" ") }),
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
            ? call.toolName === "bash"
                ? target
                : compactText(singleLineTarget(target), TOOL_TARGET_MAX_CHARACTERS)
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
    phase: IToolCallDisplayProps["phase"],
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
            accent: outcome === "manual" ? theme.amber : theme.textSecondary,
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
        result.isError && result.toolName !== "bash" ? result.content : undefined,
    ].filter((value): value is string => value !== undefined && value.length > 0)
    return details.length > 0 ? details.join(" | ") : undefined
}

function singleLineDetail(value: string): string {
    return value.replace(/\r\n|\r|\n/g, " | ").trim()
}
