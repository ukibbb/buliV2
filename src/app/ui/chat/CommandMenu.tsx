import type { ReactNode } from "react"

import type { TBuliMenuSnapshot } from "@/app/ui/ui-controller"
import { theme } from "@/terminal/theme"

const MENU_MAX_ROW_COUNT = 8

interface ICommandMenuProps {
    readonly menu: TBuliMenuSnapshot | null
}

/** Calculates and renders the visible window of the active command menu. */
export function CommandMenu(props: ICommandMenuProps): ReactNode {
    const menu = props.menu
    if (!menu) return null

    const visibleStart = Math.min(
        Math.max(menu.selectedIndex - Math.floor(MENU_MAX_ROW_COUNT / 2), 0),
        Math.max(menu.items.length - MENU_MAX_ROW_COUNT, 0),
    )
    const visibleItems = menu.items.slice(
        visibleStart,
        visibleStart + MENU_MAX_ROW_COUNT,
    )

    return (
        <box
            width="100%"
            flexDirection="column"
            paddingLeft={1}
            paddingBottom={1}
        >
            {visibleItems.map((item, index) => {
                const absoluteIndex = visibleStart + index
                const isSelected = menu.selectedIndex === absoluteIndex

                return (
                    <text key={item.id}>
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
                <text>
                    <span fg={theme.textMuted}>{menu.emptyMessage}</span>
                </text>
            ) : null}
            {menu.errorMessage ? (
                <text>
                    <span fg={theme.red}>{menu.errorMessage}</span>
                </text>
            ) : null}
        </box>
    )
}
