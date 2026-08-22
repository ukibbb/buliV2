import { useTerminalDimensions } from "@opentui/react"
import {
    useEffect,
    useEffectEvent,
    useRef,
    useState,
    type ReactNode,
} from "react"

import { SelectionClipboardBridge } from "@/terminal/clipboard/SelectionClipboardBridge"
import type { TClipboardWriter } from "@/terminal/clipboard/copy-selection"
import { theme } from "@/terminal/theme"

const DEFAULT_COPY_CONFIRMATION_TOAST_DURATION_MS = 2_000
const COPY_CONFIRMATION_TOAST_MAX_WIDTH = 32

interface ITerminalSelectionClipboardRootProps {
    readonly children: ReactNode
    readonly clipboard: TClipboardWriter
    readonly copyConfirmationToastDurationMs?: number
    readonly onClipboardWriteError?: (error: unknown) => void
}

/** Adds selection-copy handling and its transient overlay above one terminal UI root. */
export function TerminalSelectionClipboardRoot(
    props: ITerminalSelectionClipboardRootProps,
): ReactNode {
    const [isConfirmationVisible, setIsConfirmationVisible] = useState(false)
    const confirmationTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(
        undefined,
    )
    const mountedRef = useRef(false)

    const showConfirmation = useEffectEvent(() => {
        if (!mountedRef.current) return
        if (confirmationTimeoutRef.current) {
            clearTimeout(confirmationTimeoutRef.current)
        }

        setIsConfirmationVisible(true)
        confirmationTimeoutRef.current = setTimeout(() => {
            confirmationTimeoutRef.current = undefined
            setIsConfirmationVisible(false)
        }, props.copyConfirmationToastDurationMs
            ?? DEFAULT_COPY_CONFIRMATION_TOAST_DURATION_MS)
    })

    useEffect(() => {
        mountedRef.current = true
        return () => {
            mountedRef.current = false
            if (confirmationTimeoutRef.current) {
                clearTimeout(confirmationTimeoutRef.current)
            }
        }
    }, [])

    return (
        <box width="100%" height="100%" position="relative">
            {props.children}
            <SelectionClipboardBridge
                clipboard={props.clipboard}
                onCopyComplete={showConfirmation}
                {...(props.onClipboardWriteError
                    ? { onClipboardWriteError: props.onClipboardWriteError }
                    : {})}
            />
            <ClipboardCopyToast isVisible={isConfirmationVisible} />
        </box>
    )
}

function ClipboardCopyToast(props: { readonly isVisible: boolean }): ReactNode {
    const { width } = useTerminalDimensions()
    if (!props.isVisible) return null

    return (
        <box
            position="absolute"
            top={1}
            right={2}
            zIndex={1_000}
            maxWidth={Math.max(
                1,
                Math.min(COPY_CONFIRMATION_TOAST_MAX_WIDTH, width - 4),
            )}
            border={["left"]}
            borderColor={theme.green}
            backgroundColor={theme.surface}
            paddingX={2}
            paddingY={1}
        >
            <text
                fg={theme.text}
                selectable={false}
                truncate
                wrapMode="none"
            >
                Copied to clipboard
            </text>
        </box>
    )
}
