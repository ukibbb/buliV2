import { ErrorNotice } from "@/ui/chat/ErrorNotice"
import { useTerminalDimensions } from "@opentui/react"
import type { ReactNode } from "react"

import { useMenuSelectionScroll } from "@/ui/chat/use-menu-selection-scroll"
import type { TBuliMenuSnapshot } from "@/ui/ui-controller"
import { ClippedBox } from "@/ui/terminal/renderer/ClippedBox"
import { theme } from "@/ui/terminal/theme"

interface IInputMenuProps {
    readonly menu: TBuliMenuSnapshot | null
}

const MENU_HEIGHT_LIMIT_DIVISOR = 3
const MIN_MENU_HEIGHT_LIMIT_ROWS = 1
const MENU_LABEL_COLUMNS = 20

/** Presents command, picker and path suggestions without subscribing to their state. */
export function InputMenu(props: IInputMenuProps): ReactNode {
    const menu = props.menu
    const { height } = useTerminalDimensions()
    const scrollRef = useMenuSelectionScroll(menu?.selectedIndex ?? 0, menu?.items)
    if (!menu) return null

    const maxListRows = Math.max(MIN_MENU_HEIGHT_LIMIT_ROWS, Math.floor(height / MENU_HEIGHT_LIMIT_DIVISOR))
    // Notices own their minimum height. A positive panel minimum breaks shrinking
    // with a bounded list in OpenTUI 0.5.12; zero-row lists must also clip their ink.
    return <ClippedBox
        id="command-menu"
        width="100%"
        minHeight={0}
        flexShrink={1}
        flexDirection="column"
        paddingLeft={1}
    >
        <ClippedBox minHeight={0} maxHeight={maxListRows} flexShrink={1} flexDirection="column">
            <scrollbox
                ref={scrollRef}
                width="100%"
                minHeight={0}
                flexShrink={1}
                scrollY
                scrollX={false}
                wrapperOptions={{ minHeight: 0 }}
                viewportOptions={{ minHeight: 0 }}
                contentOptions={{ minHeight: 0, flexDirection: "column" }}
                verticalScrollbarOptions={{ visible: false }}
            >
                {menu.items.map((item, index) => {
                    const isSelected = menu.selectedIndex === index
                    return <text
                        key={item.id}
                        selectable={false}
                        width="100%"
                        height={1}
                        flexShrink={0}
                        wrapMode="none"
                        truncate
                    >
                        <span fg={isSelected ? theme.green : theme.amber}>
                            {`${isSelected ? "→" : " "} ${item.label.padEnd(MENU_LABEL_COLUMNS)}`}
                        </span>
                        {item.description ? <span fg={theme.textMuted}>{item.description}</span> : null}
                    </text>
                })}
            </scrollbox>
        </ClippedBox>
        {menu.items.length === 0 && menu.emptyMessage ? (
            <text selectable={false} flexShrink={0} wrapMode="word" fg={theme.textMuted}>
                {menu.emptyMessage}
            </text>
        ) : null}
        {menu.errorMessage ? (
            <ErrorNotice message={menu.errorMessage} />
        ) : null}
    </ClippedBox>
}
