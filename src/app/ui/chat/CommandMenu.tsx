import { useTerminalDimensions } from "@opentui/react"
import type { ReactNode } from "react"

import type { TBuliMenuSnapshot } from "@/app/ui/ui-controller"
import { glyphs, theme } from "@/terminal/theme"

const MENU_MAX_ROW_COUNT = 8
const CHAT_FIXED_ROW_COUNT = 8

interface ICommandMenuProps {
    readonly menu: TBuliMenuSnapshot | null
}

/** Calculates and renders the visible window of the active command menu. */
export function CommandMenu(props: ICommandMenuProps): ReactNode {
    const menu = props.menu
    const { height } = useTerminalDimensions()
    if (!menu) return null

    const visibleRowCount = Math.max(
        1,
        Math.min(MENU_MAX_ROW_COUNT, height - CHAT_FIXED_ROW_COUNT),
    )

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
            flexDirection="column"
            border={["top"]}
            borderColor={theme.border}
            backgroundColor={theme.surfaceRaised}
            paddingLeft={1}
            paddingRight={1}
        >
            {visibleItems.map((item, index) => {
                const absoluteIndex = visibleStart + index
                const isSelected = menu.selectedIndex === absoluteIndex

                return (
                    <text
                        key={item.id}
                        width="100%"
                        bg={isSelected ? theme.surfaceSelected : theme.surfaceRaised}
                        paddingX={1}
                        truncate
                        wrapMode="none"
                        selectable={false}
                    >
                        <span fg={isSelected ? theme.green : theme.textStrong}>
                            {`${isSelected ? glyphs.menuSelection : " "} ${item.label.padEnd(20)}`}
                        </span>
                        {item.description ? (
                            <span fg={isSelected ? theme.text : theme.textMuted}>
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
                <text selectable={false}>
                    <span fg={theme.red}>{menu.errorMessage}</span>
                </text>
            ) : null}
        </box>
    )
}
