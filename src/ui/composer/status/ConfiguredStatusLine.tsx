import { TextAttributes } from "@opentui/core"
import { useEffect, useState } from "react"

import type { IBuliApplication } from "@/app/contracts"
import type { IContextUsage } from "@/sessions"
import { type IAnsiSpan, parseAnsiLines } from "@/ui/terminal/ansi-text"

/** A typing burst redraws once; terminal status lines redraw at about this rate. */
const REFRESH_DELAY_MS = 300

interface IConfiguredStatusLineProps {
    readonly render: NonNullable<IBuliApplication["renderStatusLine"]>
    readonly sessionId: string | undefined
    readonly modelId: string
    readonly modelName: string
    readonly contextUsage: IContextUsage | undefined
}

/** Draws the output of the configured status line command, refreshed when the session's model or context changes; a failed run clears it. */
export function ConfiguredStatusLine(props: IConfiguredStatusLineProps) {
    const { render } = props
    const [lines, setLines] = useState<readonly IAnsiSpan[][]>([])
    const inputTokens = props.contextUsage?.estimatedInputTokens ?? 0
    const contextWindowTokens = props.contextUsage?.contextWindowTokens

    useEffect(() => {
        const controller = new AbortController()
        const timer = setTimeout(() => {
            const session = { sessionId: props.sessionId, modelId: props.modelId, modelName: props.modelName, inputTokens, contextWindowTokens }
            const show = (output: string | undefined) => {
                if (!controller.signal.aborted) setLines(output === undefined ? [] : parseAnsiLines(output))
            }
            void render(session, controller.signal).then(show, () => show(undefined))
        }, REFRESH_DELAY_MS)
        return () => {
            clearTimeout(timer)
            controller.abort()
        }
    }, [render, props.sessionId, props.modelId, props.modelName, inputTokens, contextWindowTokens])

    if (lines.length === 0) return null
    return (
        <box id="configured-status-line" width="100%" flexShrink={0} flexDirection="column" paddingLeft={1} paddingBottom={1}>
            {lines.map((line, lineIndex) => (
                <text key={lineIndex} wrapMode="none" truncate>
                    {line.length === 0 ? " " : line.map((span, spanIndex) => (
                        <span
                            key={spanIndex}
                            {...(span.fg === undefined ? {} : { fg: span.fg })}
                            {...(span.bg === undefined ? {} : { bg: span.bg })}
                            attributes={(span.bold ? TextAttributes.BOLD : 0) | (span.dim ? TextAttributes.DIM : 0)}
                        >{span.text}</span>
                    ))}
                </text>
            ))}
        </box>
    )
}
