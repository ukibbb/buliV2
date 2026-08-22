import type { ReactNode } from "react"

import type { TToolApprovalRequest } from "@/agent"
import { theme } from "@/terminal/theme"

interface IToolApprovalDetailsProps {
    readonly request: TToolApprovalRequest
}

/** Renders request-specific approval content without owning interaction state. */
export function ToolApprovalDetails(
    props: IToolApprovalDetailsProps,
): ReactNode {
    const request = props.request

    return request.kind === "patch" ? (
        <>
            <text fg={theme.amber}>Patch approval</text>
            <text wrapMode="char">{request.title}</text>
            <text fg={theme.textMuted}>Explanation</text>
            <text wrapMode="char">{request.explanation}</text>
            <text fg={theme.textMuted}>Affected paths</text>
            {request.paths.map((path, index) => (
                <text key={`${index}:${path}`} wrapMode="char">{path}</text>
            ))}
            <text fg={theme.textMuted}>Diff</text>
            <text wrapMode="char">{request.diff}</text>
        </>
    ) : (
        <>
            <text fg={theme.amber}>Command approval</text>
            <text wrapMode="char">{request.title}</text>
            <text fg={theme.textMuted}>Purpose</text>
            <text wrapMode="char">{request.purpose}</text>
            <text fg={theme.textMuted}>Command</text>
            <text wrapMode="char">{request.command}</text>
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
