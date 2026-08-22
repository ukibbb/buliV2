import type { ReactNode } from "react"

import type {
    IToolCallContent,
    IToolResultMessage,
    TToolExecutionOutcome,
} from "@/agent"
import { theme } from "@/terminal/theme"

const TOOL_LINE_MAX_CHARACTERS = 160

/** Presents a compact status line for an assistant tool call. */
export function ToolCallLine(props: {
    readonly call: IToolCallContent
    readonly running: boolean
}): ReactNode {
    const status = props.running ? "running" : "call"
    const line = compactText(
        `[${status}] ${props.call.toolName} ${JSON.stringify(props.call.input)}`,
        TOOL_LINE_MAX_CHARACTERS,
    )
    return <text fg={props.running ? theme.amber : theme.textMuted}>{line}</text>
}

/** Presents a compact status line for a tool execution result. */
export function ToolResultLine(props: { readonly message: IToolResultMessage }): ReactNode {
    const statuses: Record<TToolExecutionOutcome, string> = {
        completed: "done",
        rejected: "rejected",
        manual: "manual",
        failed: "failed",
        "committed-after-abort": "committed-after-abort",
        "effects-unknown": "effects-unknown",
    }
    const status = props.message.outcome === undefined
        ? props.message.isError ? "error" : "done"
        : statuses[props.message.outcome]
    const summary = props.message.summary
    const details = [
        summary,
        props.message.isError ? props.message.content : undefined,
    ].filter((value): value is string => value !== undefined && value.length > 0)
    const detail = details.length > 0 ? `: ${details.join(" | ")}` : ""
    const line = compactText(
        `[${status}] ${props.message.toolName}${detail}`,
        TOOL_LINE_MAX_CHARACTERS,
    )
    const isCritical = props.message.isError
        || props.message.outcome === "committed-after-abort"
        || props.message.outcome === "effects-unknown"
    return <text fg={isCritical ? theme.red : theme.textMuted}>{line}</text>
}

function compactText(value: string, maximumCharacters: number): string {
    if (value.length <= maximumCharacters) return value
    return `${value.slice(0, maximumCharacters - 3)}...`
}
