// Central Unicode glyph palette. Every usage in the codebase must import from
// here so substitutions are greppable and inspectable.
export const glyphs = {
  snakeBody: "▰",
  snakeHead: "●",
  snakeEmptyTrack: "·",
  apple: "◆",
} as const;

export type GlyphName = keyof typeof glyphs;

export const theme = {
  amber: "#F59E0B",
  red: "#EF4444",
  green: "#10B981",
  pink: "#EC4899"

} as const

export type Theme = typeof theme
