import type { KeyEvent, ScrollBoxRenderable } from "@opentui/core"
import { useRenderer } from "@opentui/react"
import { useEffect, useRef, useState, type ReactNode } from "react"

import { theme } from "@/terminal/theme"
import { ToolApprovalDetails } from "@/tools/ui/ToolApprovalDetails"
import {
    getToolApprovalActions,
    type IToolApprovalPanelProps,
} from "@/tools/ui/tool-approval-model"

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

/** Owns approval focus, navigation, scrolling, and resolution. */
export function ToolApprovalPanel(
    props: IToolApprovalPanelProps,
): ReactNode {
    const request = props.request
    const renderer = useRenderer()
    const detailsScrollRef = useRef<ScrollBoxRenderable | null>(null)
    const actions = getToolApprovalActions(request)
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
                    props.onError(
                        new Error("Clipboard copy is not supported by this terminal"),
                    )
                    return false
                }
            } catch (error) {
                const detail = error instanceof Error ? error.message : String(error)
                props.onError(
                    new Error(`Failed to copy command: ${detail}`),
                )
                return false
            }
            return true
        } : undefined

        props.onResolve(
            request.id,
            selectedAction.decision,
            copyCommand,
        )
    }

    const handleKeyDown = (key: KeyEvent): void => {
        const action = props.resolveKeyboardAction(key)
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
                <ToolApprovalDetails request={request} />
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
