import { useState, useSyncExternalStore } from "react"
import { useBuliRuntime } from "@/ui/context/application-context"
import type { IDelegatedTask } from "@/sessions"
import { SessionTranscript } from "@/ui/sessions/SessionTranscript"
import { MarkdownBody } from "@/ui/sessions/MarkdownBody"
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
        {tasks.map((task) => <ExplorerTask key={task.id} task={task} />)}
    </box>
}

function ExplorerTask({ task }: { readonly task: IDelegatedTask }) {
    const runtime = useBuliRuntime()
    const [expanded, setExpanded] = useState(false)
    const activeTool = task.status === "running" ? runtime.delegatedTasks?.currentTool(task.childSessionId) : undefined
    return <box flexDirection="column" width="100%">
        <text selectable={false} onMouseDown={() => setExpanded(value => !value)}>
            <span fg={statusColors[task.status]}>{expanded ? "[-]" : "[+]"}</span>
            <span fg={theme.text}>{` Explorer ${task.position + 1}`}</span>
            <span fg={theme.textSecondary}>{` [${task.modelId}: ${task.reasoningEffort}]`}</span>
        </text>
        {(expanded || task.error) && <box flexDirection="column" width="100%" paddingLeft={4}>
            {expanded && <text fg={theme.textSecondary}>{`Prompt:\n${task.task}`}</text>}
            {expanded && activeTool && <text fg={theme.textSecondary}>{`Narzędzie: ${activeTool}`}</text>}
            {task.error && <text fg={theme.red}>{task.error}</text>}
            {expanded && task.answer && <MarkdownBody content={task.answer} streaming={false} />}
            {expanded && <box height={20} width="100%"><SessionTranscript sessionId={task.childSessionId} delegated /></box>}
        </box>}
    </box>
}
