import { Yoga, type TextRenderable } from "@opentui/core"
import { useRef, useState, type ReactNode } from "react"

import type { TBuliMenuSnapshot } from "@/app/ui/ui-controller"
import { theme } from "@/terminal/theme"

const MENU_MAX_ROW_COUNT = 8

interface ICommandMenuProps {
    readonly menu: TBuliMenuSnapshot | null
}

/** Calculates and renders the visible window of the active command menu. */
export function CommandMenu(props: ICommandMenuProps): ReactNode {
    const menu = props.menu
    const [visibleRowCount, setVisibleRowCount] = useState(MENU_MAX_ROW_COUNT)
    const errorRef = useRef<TextRenderable | null>(null)
    if (!menu) return null

    const visibleStart = Math.min(
        Math.max(menu.selectedIndex - Math.floor(visibleRowCount / 2), 0),
        Math.max(menu.items.length - visibleRowCount, 0),
    )
    const visibleItems = menu.items.slice(
        visibleStart,
        visibleStart + visibleRowCount,
    )

    return (
        <box
            width="100%"
            flexShrink={0}
            flexDirection="column"
            paddingLeft={1}
            paddingBottom={1}
            renderAfter={function () {
                const layout = this.getLayoutNode()
                // Measure after layout, relative to Chat rather than the screen:
                // the flexible transcript above it must be able to yield space.
                const availableRows = this.ctx.height
                    - layout.getComputedTop()
                    - layout.getComputedPadding(Yoga.Edge.Bottom)
                    - (errorRef.current?.getLayoutNode().getComputedHeight() ?? 0)
                const nextRowCount = Math.max(
                    0,
                    Math.min(MENU_MAX_ROW_COUNT, Math.floor(availableRows)),
                )
                if (nextRowCount !== visibleRowCount) setVisibleRowCount(nextRowCount)
            }}
        >
            {visibleItems.map((item, index) => {
                const absoluteIndex = visibleStart + index
                const isSelected = menu.selectedIndex === absoluteIndex

                return (
                    <text
                        key={item.id}
                        selectable={false}
                        width="100%"
                        height={1}
                        wrapMode="none"
                        truncate
                    >
                        <span fg={isSelected ? theme.green : theme.text}>
                            {`${isSelected ? "→" : " "} ${item.label.padEnd(20)}`}
                        </span>
                        {item.description ? (
                            <span fg={isSelected ? theme.green : theme.textMuted}>
                                {item.description}
                            </span>
                        ) : null}
                    </text>
                )
            })}
            {menu.items.length === 0 && menu.emptyMessage ? (
                <text selectable={false}>
                    <span fg={theme.textMuted}>{menu.emptyMessage}</span>
                </text>
            ) : null}
            {menu.errorMessage ? (
                <text ref={errorRef} selectable={false}>
                    <span fg={theme.red}>{menu.errorMessage}</span>
                </text>
            ) : null}
        </box>
    )
}
