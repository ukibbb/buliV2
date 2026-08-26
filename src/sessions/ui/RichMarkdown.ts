import {
    CodeRenderable,
    createMarkdownCodeBlockRenderer,
    LineNumberRenderable,
    type MarkdownCodeBlockRenderer,
} from "@opentui/core"

import { theme } from "@/terminal/theme"

const NUMBERED_CODE_LANGUAGES = [
    "bash",
    "c",
    "cpp",
    "csharp",
    "css",
    "go",
    "html",
    "java",
    "javascript",
    "javascriptreact",
    "json",
    "kotlin",
    "lua",
    "markdown",
    "php",
    "python",
    "ruby",
    "rust",
    "sql",
    "swift",
    "toml",
    "typescript",
    "typescriptreact",
    "xml",
    "yaml",
    "zig",
] as const

const renderNumberedCodeBlock: MarkdownCodeBlockRenderer = (token, context) => {
    if (!token.text.includes("\n")) return

    const code = context.defaultRender()
    if (!(code instanceof CodeRenderable)) return code

    code.flexShrink = 1
    code.minWidth = 0
    return new LineNumberRenderable(code.ctx, {
        target: code,
        fg: theme.textMuted,
        bg: theme.surface,
        minWidth: 3,
        paddingRight: 1,
        width: "100%",
        flexShrink: 1,
    })
}

const numberedCodeBlockRenderers = new Map(
    NUMBERED_CODE_LANGUAGES.map((language) => [language, renderNumberedCodeBlock] as const),
)

// Keep this module-level so public Markdown reconciliation receives a stable renderNode.
export const renderRichMarkdownNode = createMarkdownCodeBlockRenderer(
    numberedCodeBlockRenderers,
)!
