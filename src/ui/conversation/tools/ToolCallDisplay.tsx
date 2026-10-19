import { memo, useMemo, useState, type ReactNode } from "react"
import { FileChangeDiff } from "@/ui/conversation/tools/FileChangeDiff"
import { theme } from "@/ui/terminal/theme"
import { presentToolCall, type IToolCallDisplayProps, type IToolCallPresentation } from "@/ui/conversation/tools/tool-call-presentation"
export { isVisibleTool } from "@/ui/conversation/tools/tool-call-presentation"

const TOOL_BORDER: ("left")[] = ["left"]

const toolCallStyle = {
    horizontalPadding: 1,
    verticalPadding: 0,
    leftRail: {
        topLeft: "",
        bottomLeft: "",
        vertical: "┃",
        topRight: "",
        bottomRight: "",
        horizontal: " ",
        bottomT: "",
        topT: "",
        cross: "",
        leftT: "",
        rightT: "",
    },
} as const

/** Prepares a tool call for the memoized terminal view. */
export function ToolCallDisplay(props: IToolCallDisplayProps): ReactNode {
    const presentation = presentToolCall(props)
    if (!presentation) return null
    return <ToolCallView {...presentation} />
}

/** Primitive display values remain comparable even when the provider snapshot is cloned. */
export const ToolCallView = memo(function ToolCallView(props: IToolCallPresentation): ReactNode {
    const line = <text
        fg={props.foreground}
        minWidth={0}
        flexShrink={1}
        wrapMode="word"
        truncate={false}
    >
        <span fg={theme.text}>{props.name}</span>
        {props.target === undefined ? null : <>
            <span fg={props.accent}> [</span>
            <span fg={theme.textSecondary}>{props.target}</span>
            <span fg={props.accent}>]</span>
        </>}
        {props.detail === undefined ? null : <span
            fg={props.accent}
        >{` ${props.detail}`}</span>}
        {props.marker === undefined
            ? null
            : <span fg={props.accent}>{` ${props.marker}`}</span>}
    </text>

    return <box
        width="100%"
        flexDirection="column"
        border={TOOL_BORDER}
        borderColor={props.accent}
        customBorderChars={toolCallStyle.leftRail}
    >
        <box
            width="100%"
            minWidth={0}
            flexDirection="column"
            backgroundColor={theme.surface}
            paddingX={toolCallStyle.horizontalPadding}
            paddingY={toolCallStyle.verticalPadding}
        >
            {line}
            {props.diff ? <FileChangeDiff diff={props.diff} /> : null}
            {props.output ? <BashOutput content={props.output} /> : null}
        </box>
    </box>
})

const BASH_PREVIEW_LINES = 12
const BASH_PREVIEW_CHARACTERS = 2_000

/** Disclosure affects presentation only; the recorded tool result stays unchanged. */
function BashOutput({ content }: { readonly content: string }) {
    const [expanded, setExpanded] = useState(false)
    const preview = useMemo(() => {
        const prefix = content.slice(0, 2 * (BASH_PREVIEW_CHARACTERS + 1))
        const lines = prefix.split("\n", BASH_PREVIEW_LINES + 1)
        const text = lines.slice(0, BASH_PREVIEW_LINES).join("\n")
        const characters = Array.from(text)
        const truncated = prefix.length < content.length || lines.length > BASH_PREVIEW_LINES || characters.length > BASH_PREVIEW_CHARACTERS
        return { text: characters.slice(0, BASH_PREVIEW_CHARACTERS).join(""), truncated }
    }, [content])
    return <box width="100%" flexDirection="column">
        <text fg={theme.textSecondary} wrapMode="word" truncate={false}>
            {expanded || !preview.truncated ? content : `${preview.text}\n… [Podgląd wyniku]`}
        </text>
        {preview.truncated && <text fg={theme.textSecondary} selectable={false}
            onMouseDown={() => setExpanded(value => !value)}>
            {expanded ? "[-] Zwiń wynik" : "[+] Rozwiń wynik"}
        </text>}
    </box>
}
