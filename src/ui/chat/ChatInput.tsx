import { memo, useSyncExternalStore } from "react"

import { useSessionSelector } from "@/ui/context/application-context"
import type { ISessionSnapshot } from "@/sessions"
import { PromptEditor } from "@/ui/chat/PromptEditor"
import { useBuliUiController, useBuliUiSelector } from "@/ui/context/ui-controller-context"
import { useTerminalClipboard } from "@/ui/terminal/clipboard/ClipboardOverlay"
import type { IBuliUiSnapshot } from "@/ui/ui-controller"

/** Subscribe to the resource-aware draft, not just its text, and menu openness. */
export const ChatInput = memo(function ChatInput(props: { readonly sessionId?: string | undefined }) {
    const agentId = useSessionSelector(props.sessionId, selectAgentId) ?? "buli"
    return <ChatDraft agentId={agentId} />
})

function ChatDraft({ agentId }: { readonly agentId: string }) {
    const controller = useBuliUiController()
    const value = useSyncExternalStore(controller.subscribe, controller.getInputDraft)
    const menuOpen = useBuliUiSelector(selectMenuOpen)
    const panelOpen = useBuliUiSelector(selectPanelOpen)
    const clipboard = useTerminalClipboard()
    return <PromptEditor
        value={value}
        disabled={panelOpen}
        agentId={agentId}
        onToggleBuliAgent={controller.toggleBuliAgent}
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

const selectPanelOpen = (snapshot: IBuliUiSnapshot) => Boolean(snapshot.commandPanel)
const selectAgentId = (snapshot: ISessionSnapshot) => snapshot.agentId
const selectMenuOpen = (snapshot: IBuliUiSnapshot) => snapshot.menu !== null
