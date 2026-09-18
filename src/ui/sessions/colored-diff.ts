import { fg, StyledText } from "@opentui/core"

import { theme } from "@/ui/terminal/theme"

/** Colors explanatory diffs without changing their text or inventing patch metadata. */
export function colorDiffText(content: string): StyledText {
    const lines = content.split("\n")
    return new StyledText(lines.map((line, index) => {
        const color = line.startsWith("@@") ? theme.amber
            : line.startsWith("+") ? theme.green
            : line.startsWith("-") ? theme.red
            : theme.text
        return fg(color)(line + (index < lines.length - 1 ? "\n" : ""))
    }))
}
