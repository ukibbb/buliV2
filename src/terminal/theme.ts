import { SyntaxStyle, type ThemeTokenStyle } from "@opentui/core"

// Central Unicode glyph palette. Every usage in the codebase must import from
// here so substitutions are greppable and inspectable.
export const glyphs = {
    snakeBody: "▰",
    snakeHead: "●",
    snakeEmptyTrack: "·",
    apple: "◆",
    menuSelection: "→",
} as const

export type GlyphName = keyof typeof glyphs

export const theme = {
    background: "#07111F",
    surface: "#0F1B2D",
    surfaceRaised: "#16243A",
    surfaceSelected: "#123B35",
    border: "#29415C",
    borderMuted: "#1D3047",
    textStrong: "#F8FAFC",
    text: "#E6EDF7",
    textMuted: "#94A3B8",
    textSubtle: "#64748B",
    green: "#34D399",
    greenContrast: "#052E2B",
    amber: "#FBBF24",
    red: "#FB7185",
    pink: "#F472B6",
    blue: "#60A5FA",
    cyan: "#22D3EE",
    violet: "#A78BFA",
    orange: "#FB923C",
    selectionBg: "#285E61",
    selectionFg: "#F8FAFC",
    userBackground: "#103B34",
    diffAddedBg: "#123524",
    diffAddedContentBg: "#174B34",
    diffAddedLineNumberBg: "#0F402C",
    diffRemovedBg: "#3F1D24",
    diffRemovedContentBg: "#56232F",
    diffRemovedLineNumberBg: "#491E28",
} as const

export type Theme = typeof theme

const syntaxTheme = [
    token(["default"], theme.text),
    token(["attribute", "label"], theme.amber),
    token(["boolean"], theme.orange, { bold: true }),
    token(["character"], theme.green),
    token(["character.special"], theme.amber),
    token(["comment", "comment.documentation"], theme.textSubtle, { italic: true }),
    token(["conceal"], theme.border, { dim: true }),
    token(["constant"], theme.amber),
    token(["constant.builtin"], theme.orange, { bold: true }),
    token(["constructor"], theme.blue, { bold: true }),
    token(["embedded"], theme.text),
    token(["escape", "string.escape"], theme.amber),
    token(
        ["function", "function.call", "function.method", "function.method.call"],
        theme.blue,
    ),
    token(["function.builtin"], theme.cyan, { bold: true }),
    token(
        ["keyword", "keyword.conditional", "keyword.conditional.ternary", "keyword.coroutine", "keyword.repeat"],
        theme.pink,
    ),
    token(["keyword.directive"], theme.amber),
    token(["keyword.exception"], theme.red),
    token(["keyword.function"], theme.blue),
    token(["keyword.import"], theme.violet),
    token(["keyword.modifier"], theme.pink, { italic: true }),
    token(["keyword.operator"], theme.cyan),
    token(["keyword.return"], theme.pink, { bold: true }),
    token(["keyword.type"], theme.violet, { bold: true }),
    token(["markup"], theme.text),
    token(["markup.heading"], theme.amber, { bold: true }),
    token(["markup.heading.1"], theme.amber, { bold: true, underline: true }),
    token(["markup.heading.2"], theme.amber, { bold: true }),
    token(["markup.heading.3"], theme.green, { bold: true }),
    token(["markup.heading.4"], theme.blue, { bold: true }),
    token(["markup.heading.5"], theme.violet, { bold: true }),
    token(["markup.heading.6"], theme.textMuted, { bold: true }),
    token(["markup.italic"], theme.text, { italic: true }),
    token(["markup.link", "markup.link.bracket.close"], theme.blue, { underline: true }),
    token(["markup.link.label"], theme.blue, { underline: true }),
    token(["markup.link.url"], theme.textMuted, { dim: true, underline: true }),
    token(["markup.list"], theme.green),
    token(["markup.list.checked"], theme.green, { bold: true }),
    token(["markup.list.unchecked"], theme.textMuted),
    token(["markup.quote"], theme.textMuted, { italic: true }),
    token(["markup.raw"], theme.cyan, { background: theme.surfaceRaised }),
    token(["markup.raw.block"], theme.text),
    token(["markup.strikethrough"], theme.textSubtle, { dim: true }),
    token(["markup.strong"], theme.textStrong, { bold: true }),
    token(["module"], theme.violet),
    token(["module.builtin"], theme.violet, { bold: true }),
    token(["number", "number.float"], theme.amber),
    token(["operator"], theme.cyan),
    token(["property"], theme.cyan),
    token(["punctuation", "punctuation.bracket", "punctuation.delimiter"], theme.textSubtle),
    token(["punctuation.special"], theme.amber),
    token(["string", "string.special"], theme.green),
    token(["string.regexp"], theme.cyan),
    token(["string.special.url"], theme.blue, { underline: true }),
    token(["type"], theme.violet),
    token(["type.builtin"], theme.violet, { bold: true }),
    token(["variable"], theme.text),
    token(["variable.builtin"], theme.pink),
    token(["variable.member"], theme.cyan),
    token(["variable.parameter"], theme.orange),
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
