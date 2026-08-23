import { SyntaxStyle, type ThemeTokenStyle } from "@opentui/core"

// Central Unicode glyph palette. Every usage in the codebase must import from
// here so substitutions are greppable and inspectable.
export const glyphs = {
    snakeBody: "▰",
    snakeHead: "●",
    snakeEmptyTrack: "·",
    apple: "◆",
} as const

export type GlyphName = keyof typeof glyphs

export const theme = {
    amber: "#F59E0B",
    red: "#EF4444",
    green: "#10B981",
    pink: "#EC4899",
    surface: "#0F172A",
    text: "#E5E7EB",
    textMuted: "#94A3B8",
} as const

export type Theme = typeof theme

const syntaxTheme = [
    { scope: ["none", "spell", "nospell"], style: {} },
    token(
        ["default", "embedded", "property", "variable", "variable.member"],
        theme.text,
    ),
    token(["attribute", "label"], theme.amber),
    token(["boolean"], theme.amber, { bold: true }),
    token(["character", "string", "string.special"], theme.green),
    token(["character.special", "escape", "string.escape"], theme.amber),
    token(["comment", "comment.documentation"], theme.textMuted, {
        italic: true,
    }),
    token(["conceal"], theme.textMuted, { dim: true }),
    token(["constant", "number", "number.float"], theme.amber),
    token(["constant.builtin"], theme.amber, { bold: true }),
    token(["constructor", "module", "type"], theme.amber),
    token(["module.builtin", "type.builtin"], theme.amber, { bold: true }),
    token(
        ["function", "function.call", "function.method", "function.method.call"],
        theme.green,
    ),
    token(["function.builtin"], theme.green, { bold: true }),
    token(
        [
            "keyword",
            "keyword.conditional",
            "keyword.conditional.ternary",
            "keyword.coroutine",
            "keyword.function",
            "keyword.import",
            "keyword.operator",
            "keyword.repeat",
        ],
        theme.pink,
    ),
    token(["keyword.directive"], theme.amber),
    token(["keyword.exception"], theme.red, { bold: true }),
    token(["keyword.modifier"], theme.pink, { italic: true }),
    token(["keyword.return"], theme.pink, { bold: true }),
    token(["keyword.type"], theme.amber, { bold: true }),
    token(["operator"], theme.pink),
    token(
        ["punctuation", "punctuation.bracket", "punctuation.delimiter"],
        theme.textMuted,
    ),
    token(["punctuation.special"], theme.amber),
    token(["string.regexp"], theme.green, { underline: true }),
    token(["string.special.url"], theme.green, { underline: true }),
    token(["variable.builtin"], theme.pink),
    token(["variable.parameter"], theme.amber),
    token(["markup"], theme.text),
    token(["markup.heading", "markup.heading.1"], theme.amber, {
        bold: true,
        underline: true,
    }),
    token(["markup.heading.2"], theme.amber, { bold: true }),
    token(["markup.heading.3"], theme.green, { bold: true }),
    token(["markup.heading.4"], theme.pink, { bold: true }),
    token(["markup.heading.5"], theme.text, { bold: true }),
    token(["markup.heading.6"], theme.textMuted, { bold: true }),
    token(["markup.italic"], theme.text, { italic: true }),
    token(["markup.strong"], theme.text, { bold: true }),
    token(["markup.strikethrough"], theme.textMuted, { dim: true }),
    token(["markup.link", "markup.link.bracket.close"], theme.green, {
        underline: true,
    }),
    token(["markup.link.label"], theme.green, { underline: true }),
    token(["markup.link.url"], theme.textMuted, {
        dim: true,
        underline: true,
    }),
    token(["markup.list"], theme.green),
    token(["markup.list.checked"], theme.green, { bold: true }),
    token(["markup.list.unchecked"], theme.textMuted),
    token(["markup.quote"], theme.textMuted, { italic: true }),
    token(["markup.raw"], theme.amber, { background: theme.surface }),
    token(["markup.raw.block"], theme.text),
] satisfies ThemeTokenStyle[]

export const syntax = SyntaxStyle.fromTheme(syntaxTheme)

function token(
    scope: string[],
    foreground: string,
    attributes: {
        readonly background?: string
        readonly bold?: boolean
        readonly italic?: boolean
        readonly underline?: boolean
        readonly dim?: boolean
    } = {},
): ThemeTokenStyle {
    return {
        scope,
        style: {
            foreground,
            ...attributes,
        },
    }
}
