import type { ReactNode } from "react"

import type {
    IToolCallContent,
    IToolResultMessage,
    TToolExecutionOutcome,
} from "@/agent"
import { glyphs, theme } from "@/terminal/theme"

const TOOL_LINE_MAX_CHARACTERS = 160
const TOOL_NAME_MAX_CHARACTERS = 40
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

    const presentation = props.call
        ? toolPresentation(props.call)
        : { name: displayToolName(toolName), target: undefined, activeStatus: "running..." }
    const state = activityState(props.result, props.phase)
    const name = compactText(
        singleLineTarget(presentation.name),
        TOOL_NAME_MAX_CHARACTERS,
    )
    const target = presentation.target === undefined
        ? undefined
        : compactText(singleLineTarget(presentation.target), TOOL_TARGET_MAX_CHARACTERS)
    const targetText = target === undefined ? "" : ` [${target}]`
    const status = state.live
        ? props.phase === "running" ? presentation.activeStatus : "pending..."
        : state.status
    const markerText = state.marker === undefined ? "" : ` ${state.marker}`
    const statusText = status === undefined ? "" : ` ${status}`
    const availableDetailCharacters = Math.max(
        0,
        TOOL_LINE_MAX_CHARACTERS
            - characterLength(name)
            - characterLength(targetText)
            - characterLength(statusText)
            - characterLength(markerText)
            - 1,
    )
    const detail = state.detail === undefined || availableDetailCharacters === 0
        ? undefined
        : compactText(singleLineDetail(state.detail), availableDetailCharacters)

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
        {status === undefined ? null : <span fg={state.accent}>{` ${status}`}</span>}
        {state.marker === undefined
            ? null
            : <span fg={state.accent}>{` ${state.marker}`}</span>}
    </text>
}

interface IToolPresentation {
    readonly name: string
    readonly target?: string
    readonly activeStatus: string
}

function toolPresentation(call: IToolCallContent): IToolPresentation {
    switch (call.toolName) {
        case "bash":
            return knownToolPresentation("Bash", call, "command", "running...")
        case "read":
            return knownToolPresentation("Read", call, "path", "reading...")
        case "glob":
            return knownToolPresentation("Glob", call, "pattern", "searching...")
        case "grep":
            return knownToolPresentation("Grep", call, "pattern", "searching...")
        case "apply_patch":
            return knownToolPresentation("Apply patch", call, "explanation", "applying...")
        default:
            return {
                name: displayToolName(call.toolName),
                target: JSON.stringify(call.input),
                activeStatus: "running...",
            }
    }
}

function knownToolPresentation(
    name: string,
    call: IToolCallContent,
    targetKey: string,
    activeStatus: string,
): IToolPresentation {
    const target = call.input[targetKey]
    return {
        name,
        target: typeof target === "string" ? target : JSON.stringify(call.input),
        activeStatus,
    }
}

function displayToolName(toolName: string): string {
    switch (toolName) {
        case "bash": return "Bash"
        case "read": return "Read"
        case "glob": return "Glob"
        case "grep": return "Grep"
        case "apply_patch": return "Apply patch"
        default: return toolName
    }
}

interface IToolActivityState {
    readonly live: boolean
    readonly critical: boolean
    readonly accent: string
    readonly detail?: string
    readonly status?: string
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
                status: "not run",
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
            detail: detail ?? outcomeStatus(outcome),
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
    const details = [
        result.summary,
        result.isError ? result.content : undefined,
    ].filter((value): value is string => value !== undefined && value.length > 0)
    return details.length > 0 ? details.join(" | ") : undefined
}

function outcomeStatus(outcome: Extract<TToolExecutionOutcome, "rejected" | "manual">): string {
    return outcome === "rejected" ? "rejected" : "manual"
}

function singleLineTarget(value: string): string {
    return value
        .replaceAll("\r", "\\r")
        .replaceAll("\n", "\\n")
        .replaceAll("\t", "\\t")
}

function singleLineDetail(value: string): string {
    return value.replace(/\r\n|\r|\n/g, " | ").trim()
}

function compactText(value: string, maximumCharacters: number): string {
    const characters = [...value]
    if (characters.length <= maximumCharacters) return value
    if (maximumCharacters <= 3) return ".".repeat(Math.max(0, maximumCharacters))
    return `${characters.slice(0, maximumCharacters - 3).join("")}...`
}

function characterLength(value: string): number {
    return [...value].length
}
