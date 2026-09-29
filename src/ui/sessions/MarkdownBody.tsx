import type { ReactNode } from "react"

import { syntax, theme } from "@/ui/terminal/theme"

const MARKDOWN_TABLE_OPTIONS = {
    style: "grid",
    widthMode: "full",
    columnFitter: "proportional",
    wrapMode: "word",
    cellPaddingX: 1,
    cellPaddingY: 0,
    borders: true,
    outerBorder: true,
    borderStyle: "single",
    borderColor: theme.textMuted,
    selectable: true,
} as const

/** Renders Markdown with native code blocks and transcript table styling. */
export function MarkdownBody(props: {
    readonly content: string
    readonly streaming: boolean
}): ReactNode {
    return <markdown
        fg={theme.text}
        content={props.content}
        syntaxStyle={syntax}
        streaming={props.streaming}
        conceal
        concealCode={false}
        internalBlockMode="top-level"
        tableOptions={MARKDOWN_TABLE_OPTIONS}
    />
}
