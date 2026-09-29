import { MAIN_BRANCH_ID } from "@/sessions"
import type { ISessionSnapshot } from "@/sessions"
import { useSessionSelector } from "@/ui/context/application-context"
import { sameSnapshotFields } from "@/ui/context/use-snapshot-selector"
import { theme } from "@/ui/terminal/theme"

export function SessionIndicators(props: { readonly sessionId: string | undefined }) {
    const session = useSessionSelector(props.sessionId, selectIndicators, sameSnapshotFields)
    return <SessionIndicatorContent {...session} />
}

export function SessionIndicatorContent(props: Pick<ISessionSnapshot, "activeBranchId" | "activeMcpServers">) {
    const branched = props.activeBranchId !== MAIN_BRANCH_ID
    if (!branched && !props.activeMcpServers?.length) return null
    return <box width="100%" flexShrink={0} flexDirection="column" border={["left"]} borderColor={theme.green} paddingLeft={1}>
        {branched ? <text fg={theme.green} wrapMode="word">
            BRANCH | tylko odczyt | /return — wróć do rozmowy nadrzędnej
        </text> : null}
        {props.activeMcpServers?.map((server) => <box key={server.serverId} flexDirection="column" width="100%">
            <text fg={theme.green} wrapMode="word">
                {`MCP: ${server.serverId === "novibe" ? "NoVibe | /novibe off — wyłącz" : server.serverId}`}
            </text>
            <text fg={theme.textMuted} wrapMode="word">
                {server.toolNames.length ? `Narzędzia: ${server.toolNames.join(", ")}` : "Brak dostępnych narzędzi w tej gałęzi"}
            </text>
        </box>)}
    </box>
}

function selectIndicators(session: ISessionSnapshot) {
    return { activeBranchId: session.activeBranchId, ...(session.activeMcpServers === undefined ? {} : { activeMcpServers: session.activeMcpServers }) }
}
