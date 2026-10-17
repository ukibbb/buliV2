import { memo, type ReactNode } from "react"
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
        </box>
    </box>
})
