import { useMemo, useState, useSyncExternalStore } from "react"
import { useBuliRuntime } from "@/ui/context/application-context"
import { EXPLORER_AGENT_ID } from "@/agent"
import type { IDelegatedTask } from "@/sessions"
import { SessionConversationHistory } from "@/ui/conversation/history/SessionConversationHistory"
import { MarkdownContent } from "@/ui/conversation/messages/MarkdownContent"
import { theme } from "@/ui/terminal/theme"

const subscribeNothing = () => () => {}
const zero = () => 0
const statusColors = {
    running: theme.amber,
    completed: theme.green,
    failed: theme.red,
    cancelled: theme.textSecondary,
    interrupted: theme.textSecondary,
} as const

export function DelegatedTaskDisplay(props: { readonly sessionId: string; readonly assistantMessageId: string; readonly toolCallId: string }) {
    const service = useBuliRuntime().delegatedTasks
    useSyncExternalStore(service?.subscribe ?? subscribeNothing, service?.getSnapshot ?? zero)
    const tasks = service?.list(props.sessionId, props.assistantMessageId, props.toolCallId) ?? []
    return <box flexDirection="column" width="100%">
        {tasks.map((task) => <DelegatedTaskRow key={task.id} task={task} />)}
    </box>
}

function DelegatedTaskRow({ task }: { readonly task: IDelegatedTask }) {
    const [expanded, setExpanded] = useState(false)
    return <box flexDirection="column" width="100%">
        <text selectable={false} onMouseDown={() => setExpanded(value => !value)}>
            <span fg={statusColors[task.status]}>{expanded ? "[-]" : "[+]"}</span>
            <span fg={theme.text}>{` ${agentLabel(task)} ${task.position + 1}`}</span>
            <span fg={theme.textSecondary}>{` [${task.modelId}: ${task.reasoningEffort}]`}</span>
        </text>
        {(expanded || task.error) && <box flexDirection="column" width="100%" paddingLeft={4}>
            {expanded && <text fg={theme.textSecondary}>{`Prompt:\n${task.task}`}</text>}
            {expanded && task.status === "running" && <ActiveDelegatedTool sessionId={task.childSessionId} />}
            {task.error && <text fg={theme.red}>{task.error}</text>}
            {expanded && task.answer && <MarkdownContent content={task.answer} streaming={false} />}
            {expanded && <box height={20} width="100%"><SessionConversationHistory sessionId={task.childSessionId} delegated /></box>}
        </box>}
    </box>
}

/** Only expanded running cards observe their child's tool activity. */
function ActiveDelegatedTool({ sessionId }: { readonly sessionId: string }) {
    const service = useBuliRuntime().delegatedTasks
    const source = useMemo(() => service?.open(sessionId), [service, sessionId])
    const getToolName = useMemo(() => () => service?.currentTool(sessionId), [service, sessionId])
    const activeTool = useSyncExternalStore(source?.subscribe ?? subscribeNothing, getToolName)
    return activeTool ? <text fg={theme.textSecondary}>{`Narzędzie: ${activeTool}`}</text> : null
}

/** Explorer keeps its display name; configured subagents show their own id. Older records have no agent. */
function agentLabel(task: IDelegatedTask): string {
    return task.agentId === undefined || task.agentId === EXPLORER_AGENT_ID ? "Explorer" : task.agentId
}
