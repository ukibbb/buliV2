import { BULI_YOLO_AGENT_ID } from "@/agent"
import { theme } from "@/ui/terminal/theme"

/** Conversation accent for the currently selected agent, not message provenance. */
export function agentAccentColor(agentId: string | undefined): string {
    return agentId === BULI_YOLO_AGENT_ID ? theme.amber : theme.pink
}
