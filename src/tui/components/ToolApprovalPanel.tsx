import type { KeyEvent, ScrollBoxRenderable } from "@opentui/core"
import { useRenderer } from "@opentui/react"
import { useEffect, useRef, useState, type ReactNode } from "react"

import type {
    TToolApprovalDecision,
    TToolApprovalRequest,
} from "@/domain"
import { resolveApprovalKeyboardAction } from "@/tui/app/keyboard-shortcuts"
import { useBuliUiController } from "@/tui/app/ui-controller-context"
import { theme } from "@/tui/theme"

const ASCII_BORDER = {
    topLeft: "+",
    topRight: "+",
    bottomLeft: "+",
    bottomRight: "+",
    horizontal: "-",
    vertical: "|",
    topT: "+",
    bottomT: "+",
    leftT: "+",
    rightT: "+",
    cross: "+",
} as const

interface IToolApprovalPanelProps {
    readonly request: TToolApprovalRequest
}

interface IToolApprovalAction {
    readonly label: string
    readonly decision: TToolApprovalDecision
}

const PATCH_ACTIONS: readonly IToolApprovalAction[] = [
    { label: "Reject", decision: "reject" },
    { label: "Apply", decision: "approve" },
]

const COMMAND_ACTIONS: readonly IToolApprovalAction[] = [
    { label: "Copy", decision: "copy" },
    { label: "Run once", decision: "approve" },
    { label: "Reject", decision: "reject" },
]

export function ToolApprovalPanel(
    props: IToolApprovalPanelProps,
): ReactNode {
    const request = props.request
    const controller = useBuliUiController()
    const renderer = useRenderer()
    const detailsScrollRef = useRef<ScrollBoxRenderable | null>(null)
    const actions = request.kind === "patch" ? PATCH_ACTIONS : COMMAND_ACTIONS
    const [selection, setSelection] = useState({
        requestId: request.id,
        index: 0,
    })
    const selectedIndex = selection.requestId === request.id
        ? selection.index
        : 0

    useEffect(() => {
        detailsScrollRef.current?.scrollTo(0)
    }, [request.id])

    const moveSelection = (direction: -1 | 1): void => {
        setSelection((current) => {
            const currentIndex = current.requestId === request.id
                ? current.index
                : 0
            return {
                requestId: request.id,
                index: (currentIndex + direction + actions.length) % actions.length,
            }
        })
    }

    const activateSelection = (): void => {
        const selectedAction = actions[selectedIndex]
        if (!selectedAction) return

        const copyCommand = selectedAction.decision === "copy" ? (): boolean => {
            if (request.kind !== "command") return false
            try {
                if (!renderer.copyToClipboardOSC52(request.command)) {
                    controller.setExternalUiError(
                        new Error("Clipboard copy is not supported by this terminal"),
                    )
                    return false
                }
            } catch (error) {
                const detail = error instanceof Error ? error.message : String(error)
                controller.setExternalUiError(
                    new Error(`Failed to copy command: ${detail}`),
                )
                return false
            }
            return true
        } : undefined

        controller.resolveToolApproval(
            request.id,
            selectedAction.decision,
            copyCommand,
        )
    }

    const handleKeyDown = (key: KeyEvent): void => {
        const action = resolveApprovalKeyboardAction(key)
        if (!action) return

        key.preventDefault()
        key.stopPropagation()

        if (action === "approval.previous") moveSelection(-1)
        if (action === "approval.next") moveSelection(1)
        if (action === "approval.activate") activateSelection()
        if (action === "approval.scrollUp") {
            detailsScrollRef.current?.scrollBy(-1, "viewport")
        }
        if (action === "approval.scrollDown") {
            detailsScrollRef.current?.scrollBy(1, "viewport")
        }
        if (action === "approval.scrollStart") {
            detailsScrollRef.current?.scrollTo(0)
        }
        if (action === "approval.scrollEnd") {
            const details = detailsScrollRef.current
            if (details) {
                details.scrollTo(
                    Math.max(0, details.scrollHeight - details.viewport.height),
                )
            }
        }
    }

    return (
        <box
            id="tool-approval-panel"
            width="100%"
            minHeight={0}
            flexGrow={1}
            flexDirection="column"
            border
            borderStyle="single"
            customBorderChars={ASCII_BORDER}
            borderColor={theme.amber}
            focusedBorderColor={theme.amber}
            paddingX={1}
            marginTop={1}
            focusable
            focused
            onKeyDown={handleKeyDown}
        >
            <scrollbox
                id="tool-approval-details"
                ref={detailsScrollRef}
                width="100%"
                minHeight={0}
                flexGrow={1}
                scrollY
                viewportCulling={false}
                contentOptions={{ flexDirection: "column" }}
            >
                <text fg={theme.amber}>
                    {request.kind === "patch" ? "Patch approval" : "Command approval"}
                </text>
                <text wrapMode="char">{request.title}</text>
                {request.kind === "patch" ? (
                    <>
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
                )}
            </scrollbox>
            <box flexShrink={0} flexDirection="column" marginTop={1}>
                {actions.map((action, index) => (
                    <text
                        key={action.decision}
                        fg={index === selectedIndex ? theme.green : theme.textMuted}
                    >
                        {`${index === selectedIndex ? ">" : " "} ${action.label}`}
                    </text>
                ))}
                <text fg={theme.textMuted}>
                    PageUp/PageDown review | Arrows select | Enter confirm | Esc stop
                </text>
            </box>
        </box>
    )
}
