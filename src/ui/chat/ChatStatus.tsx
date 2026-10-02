import type { TAgentRunEndReason } from "@/agent"
import type { IContextUsage } from "@/sessions"
import { theme } from "@/ui/terminal/theme"

interface IChatStatusProps {
    readonly isRunning: boolean | undefined
    readonly isCompacting: boolean | undefined
    readonly contextUsage: IContextUsage | undefined
    readonly lastRunReason: TAgentRunEndReason | undefined
    readonly errorMessage: string | undefined
    readonly inputError: string | null
    readonly selectedModelName: string
    readonly reasoningEffort: string
}

/** Renders errors, model, reasoning effort, and context usage. */
export function ChatStatus(props: IChatStatusProps) {
    return (
        <box
            id="chat-status"
            width="100%"
            flexShrink={0}
            flexDirection="row"
            flexWrap="wrap"
            paddingLeft={1}
            paddingBottom={1}
            columnGap={1}
            rowGap={0}
        >
            <text minWidth={0} flexShrink={1} truncate={false} wrapMode="word">
                <span>[ </span>
                <span fg={theme.green}>{props.selectedModelName}</span>
                <span> : </span>
                <span fg={theme.amber}>{props.reasoningEffort}</span>
                <span> ]</span>
            </text>
            {props.contextUsage ? <text fg={theme.textSecondary} minWidth={0} flexShrink={1} wrapMode="word">
                {`| ${formatContextUsage(props.contextUsage)}`}
            </text> : null}
        </box>
    )
}

function formatContextUsage(usage: IContextUsage): string {
    const used = formatTokens(usage.estimatedInputTokens)
    if (usage.contextWindowTokens === undefined) return `ctx ~${used}`
    const percent = Math.round((usage.usageRatio ?? 0) * 100)
    return `ctx ~${used}/${formatTokens(usage.contextWindowTokens)} (${percent}%)`
}

function formatTokens(value: number): string {
    if (value < 1_000) return Math.max(0, value).toLocaleString()
    if (value < 10_000) return `${(value / 1_000).toFixed(1)}k`
    if (value < 1_000_000) return `${Math.round(value / 1_000)}k`
    if (value < 10_000_000) return `${(value / 1_000_000).toFixed(1)}m`
    return `${Math.round(value / 1_000_000)}m`
}
