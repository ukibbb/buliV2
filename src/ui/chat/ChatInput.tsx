import { useSyncExternalStore } from "react"

import { PromptEditor } from "@/ui/chat/PromptEditor"
import { useBuliUiController, useBuliUiSelector } from "@/ui/context/ui-controller-context"
import { useTerminalClipboard } from "@/ui/terminal/clipboard/ClipboardOverlay"
import type { IBuliUiSnapshot } from "@/ui/ui-controller"

/** Subscribe to the resource-aware draft, not just its text, and menu openness. */
export function ChatInput() {
    const controller = useBuliUiController()
    const value = useSyncExternalStore(controller.subscribe, controller.getInputDraft)
    const menuOpen = useBuliUiSelector(selectMenuOpen)
    const clipboard = useTerminalClipboard()
    return <PromptEditor
        value={value}
        menuOpen={menuOpen}
        {...(clipboard?.read ? { clipboard: { read: clipboard.read } } : {})}
        getCurrentValue={controller.getInputDraft}
        onValueChange={controller.updateDraft}
        onSubmit={controller.submitInput}
        onMoveMenuSelection={controller.moveMenuSelection}
        onActivateMenuItem={controller.activateSelectedMenuItem}
        onError={controller.setExternalUiError}
    />
}

const selectMenuOpen = (snapshot: IBuliUiSnapshot) => snapshot.menu !== null
