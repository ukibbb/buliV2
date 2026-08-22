import { pathToFiletype } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/react"
import type { ReactNode } from "react"

import type { TToolApprovalRequest } from "@/agent"
import { syntax, theme } from "@/terminal/theme"
import { splitWorkspaceDiff } from "@/tools/ui/workspace-diff"

interface IToolApprovalDetailsProps {
    readonly request: TToolApprovalRequest
}

const TEXT_SELECTION = {
    selectionBg: theme.selectionBg,
    selectionFg: theme.selectionFg,
} as const

/** Renders request-specific approval content without owning interaction state. */
export function ToolApprovalDetails(
    props: IToolApprovalDetailsProps,
): ReactNode {
    const request = props.request
    const { width } = useTerminalDimensions()
    const diffSections = request.kind === "patch"
        ? splitWorkspaceDiff(request.diff)
        : []

    return request.kind === "patch" ? (
        <>
            <text {...TEXT_SELECTION} fg={theme.amber}>
                <strong>Patch approval</strong>
            </text>
            <text {...TEXT_SELECTION} fg={theme.textStrong} wrapMode="word">
                {request.title}
            </text>
            <text {...TEXT_SELECTION} fg={theme.textMuted}>Explanation</text>
            <text {...TEXT_SELECTION} fg={theme.text} wrapMode="word">
                {request.explanation}
            </text>
            <text {...TEXT_SELECTION} fg={theme.textMuted}>Affected paths</text>
            {request.paths.map((path, index) => (
                <text
                    {...TEXT_SELECTION}
                    key={`${index}:${path}`}
                    fg={theme.cyan}
                    wrapMode="char"
                >{path}</text>
            ))}
            <text {...TEXT_SELECTION} fg={theme.textMuted}>Diff</text>
            {diffSections.length === 0 ? (
                <>
                    <text {...TEXT_SELECTION} fg={theme.amber}>
                        Raw diff (unrecognized format)
                    </text>
                    <text {...TEXT_SELECTION} fg={theme.text} wrapMode="char">
                        {request.diff}
                    </text>
                </>
            ) : diffSections.map((section, index) => (
                <box
                    key={`${index}:${section.label}`}
                    width="100%"
                    flexDirection="column"
                    flexShrink={0}
                    marginTop={index === 0 ? 0 : 1}
                >
                    <text {...TEXT_SELECTION} fg={theme.textStrong}>
                        <strong>{section.label}</strong>
                    </text>
                    <diff
                        id={`patch-diff-${index}`}
                        diff={section.diff}
                        view={width > 120 ? "split" : "unified"}
                        syncScroll
                        width="100%"
                        flexShrink={0}
                        wrapMode="word"
                        showLineNumbers
                        filetype={pathToFiletype(section.filePath) ?? "plaintext"}
                        syntaxStyle={syntax}
                        fg={theme.text}
                        selectionBg={theme.selectionBg}
                        selectionFg={theme.selectionFg}
                        lineNumberFg={theme.textMuted}
                        lineNumberBg={theme.surface}
                        contextBg={theme.surface}
                        contextContentBg={theme.background}
                        addedBg={theme.diffAddedBg}
                        addedContentBg={theme.diffAddedContentBg}
                        addedLineNumberBg={theme.diffAddedLineNumberBg}
                        removedBg={theme.diffRemovedBg}
                        removedContentBg={theme.diffRemovedContentBg}
                        removedLineNumberBg={theme.diffRemovedLineNumberBg}
                        addedSignColor={theme.green}
                        removedSignColor={theme.red}
                    />
                    {(
                        !section.hasHunks
                        || section.hasNoNewlineMetadata
                    ) && (
                        <>
                            <text {...TEXT_SELECTION} fg={theme.amber}>
                                Exact raw diff metadata
                            </text>
                            <text
                                {...TEXT_SELECTION}
                                fg={theme.text}
                                wrapMode="char"
                            >{section.diff}</text>
                        </>
                    )}
                </box>
            ))}
        </>
    ) : (
        <>
            <text {...TEXT_SELECTION} fg={theme.amber}>
                <strong>Command approval</strong>
            </text>
            <text {...TEXT_SELECTION} fg={theme.textStrong} wrapMode="word">
                {request.title}
            </text>
            <text {...TEXT_SELECTION} fg={theme.textMuted}>Purpose</text>
            <text {...TEXT_SELECTION} fg={theme.text} wrapMode="word">
                {request.purpose}
            </text>
            <text {...TEXT_SELECTION} fg={theme.textMuted}>Command</text>
            <code
                content={request.command}
                filetype="bash"
                syntaxStyle={syntax}
                conceal={false}
                fg={theme.text}
                bg={theme.surfaceRaised}
                selectionBg={theme.selectionBg}
                selectionFg={theme.selectionFg}
                wrapMode="word"
                padding={1}
            />
            <text {...TEXT_SELECTION} fg={theme.textMuted}>Explanation</text>
            <text {...TEXT_SELECTION} fg={theme.text} wrapMode="word">
                {request.explanation}
            </text>
            <text {...TEXT_SELECTION} fg={theme.textMuted}>
                Working directory
            </text>
            <text {...TEXT_SELECTION} fg={theme.cyan} wrapMode="char">
                {request.cwd}
            </text>
            <text {...TEXT_SELECTION} fg={theme.textMuted}>Timeout</text>
            <text {...TEXT_SELECTION} fg={theme.text}>
                {`${request.timeoutSeconds} seconds`}
            </text>
            <text {...TEXT_SELECTION} fg={theme.textMuted}>
                Expected outcome
            </text>
            <text {...TEXT_SELECTION} fg={theme.text} wrapMode="word">
                {request.expectedOutcome}
            </text>
            <text {...TEXT_SELECTION} fg={theme.textMuted}>Side effects</text>
            <text {...TEXT_SELECTION} fg={theme.text} wrapMode="word">
                {request.sideEffects}
            </text>
            <text {...TEXT_SELECTION} fg={theme.textMuted}>Isolation</text>
            <text {...TEXT_SELECTION} fg={theme.amber} wrapMode="word">
                Not sandboxed; deliberately detached processes may outlive this run.
            </text>
        </>
    )
}
