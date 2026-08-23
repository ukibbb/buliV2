import { pathToFiletype } from "@opentui/core"
import type { ReactNode } from "react"

import type { TToolApprovalRequest } from "@/agent"
import { syntax, theme } from "@/terminal/theme"
import { splitWorkspaceDiff } from "@/tools/ui/workspace-diff"

interface IToolApprovalDetailsProps {
    readonly request: TToolApprovalRequest
}

/** Renders request-specific approval content without owning interaction state. */
export function ToolApprovalDetails(
    props: IToolApprovalDetailsProps,
): ReactNode {
    const request = props.request
    const diffSections = request.kind === "patch"
        ? splitWorkspaceDiff(request.diff)
        : []

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
            {diffSections.length === 0 ? (
                <>
                    <text fg={theme.amber}>Raw diff (unrecognized format)</text>
                    <text wrapMode="char">{request.diff}</text>
                </>
            ) : diffSections.map((section, index) => (
                <box
                    key={`${index}:${section.label}`}
                    width="100%"
                    flexDirection="column"
                    flexShrink={0}
                    marginTop={index === 0 ? 0 : 1}
                >
                    <text fg={theme.textMuted}>{section.label}</text>
                    <diff
                        id={`patch-diff-${index}`}
                        diff={section.diff}
                        view="unified"
                        width="100%"
                        flexShrink={0}
                        wrapMode="word"
                        showLineNumbers
                        filetype={pathToFiletype(section.filePath) ?? "plaintext"}
                        syntaxStyle={syntax}
                        conceal={false}
                        fg={theme.text}
                        lineNumberFg={theme.textMuted}
                        lineNumberBg={theme.surface}
                        contextBg={theme.surface}
                        addedBg="#123524"
                        removedBg="#3F1D24"
                        addedSignColor={theme.green}
                        removedSignColor={theme.red}
                    />
                    {(
                        !section.hasHunks
                        || section.hasNoNewlineMetadata
                    ) && (
                        <>
                            <text fg={theme.amber}>Exact raw diff metadata</text>
                            <text wrapMode="char">{section.diff}</text>
                        </>
                    )}
                </box>
            ))}
        </>
    ) : (
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
