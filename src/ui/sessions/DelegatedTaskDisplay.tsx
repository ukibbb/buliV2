import { useState, useSyncExternalStore } from "react"
import { useBuliRuntime } from "@/ui/context/application-context"
import type { IDelegatedTask } from "@/sessions"
import { ToolCallView } from "@/ui/sessions/ToolCallDisplay"
import { SessionTranscript } from "@/ui/sessions/SessionTranscript"
import { theme } from "@/ui/terminal/theme"

const subscribeNothing = () => () => {}
const zero = () => 0
const labels = { running: "w toku", completed: "zakończony", failed: "błąd", cancelled: "anulowany", interrupted: "przerwany" } as const

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
    const [error, setError] = useState<string>()
    const activeTool = task.status === "running" ? runtime.delegatedTasks?.currentTool(task.childSessionId) : undefined
    return <box flexDirection="column" width="100%">
        <ToolCallView name={`Explorer ${task.position + 1}`} target={`${task.modelId}: ${task.reasoningEffort}`}
            detail={undefined} foreground={theme.text} accent={theme.explorer} marker={undefined} diff={undefined} />
        <text fg={task.status === "failed" ? theme.red : task.status === "completed" ? theme.green : theme.textSecondary}>
            {`[${labels[task.status]}] ${task.task}`}
        </text>
        {activeTool && <text fg={theme.textSecondary}>{`Narzędzie: ${activeTool}`}</text>}
        <box flexDirection="row">
            <text fg={theme.textSecondary} selectable={false} onMouseDown={() => setExpanded(!expanded)}>
                {expanded ? "[Zwiń przebieg]" : "[Otwórz przebieg]"}
            </text>
            {task.status === "running" && <text fg={theme.textSecondary} selectable={false}
                onMouseDown={() => { void runtime.delegatedTasks?.abort(task.childSessionId).catch((cause: unknown) => setError(String(cause))) }}>
                {" [Zatrzymaj]"}
            </text>}
        </box>
        {(error || task.error) && <text fg={theme.red}>{error ?? task.error}</text>}
        {expanded && task.answer && <text fg={theme.text}>{task.answer}</text>}
        {expanded && <box height={20} width="100%"><SessionTranscript sessionId={task.childSessionId} delegated /></box>}
    </box>
}
