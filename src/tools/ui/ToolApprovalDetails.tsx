import type { ReactNode } from "react"

import type { TToolApprovalRequest } from "@/agent"
import { syntax, theme } from "@/terminal/theme"

interface IToolApprovalDetailsProps {
    readonly request: TToolApprovalRequest
}

/** Renders request-specific approval content without owning interaction state. */
export function ToolApprovalDetails(
    props: IToolApprovalDetailsProps,
): ReactNode {
    const request = props.request

    return (
        <>
            <text fg={theme.amber}>Command approval</text>
            <text wrapMode="char">{request.title}</text>
            <text fg={theme.textMuted}>Purpose</text>
            <text wrapMode="char">{request.purpose}</text>
            <text fg={theme.textMuted}>Command</text>
            <code
                content={request.command}
                filetype="bash"
                syntaxStyle={syntax}
                conceal={false}
                drawUnstyledText
                fg={theme.text}
                wrapMode="word"
            />
            <text fg={theme.textMuted}>Explanation</text>
            <text wrapMode="char">{request.explanation}</text>
            <text fg={theme.textMuted}>Working directory</text>
            <text wrapMode="char">{request.cwd}</text>
            <text fg={theme.textMuted}>Timeout</text>
            <text>{`${request.timeoutSeconds} seconds`}</text>
            <text fg={theme.textMuted}>Expected outcome</text>
            <text wrapMode="char">{request.expectedOutcome}</text>
            <text fg={theme.textMuted}>Side effects</text>
            <text wrapMode="char">{request.sideEffects}</text>
            <text fg={theme.textMuted}>Isolation</text>
            <text wrapMode="char">
                Not sandboxed; deliberately detached processes may outlive this run.
            </text>
        </>
    )
}
