import { InputMenu } from "@/ui/chat/InputMenu"
import { useBuliUiSelector } from "@/ui/context/ui-controller-context"
import type { IBuliUiSnapshot } from "@/ui/ui-controller"

/** Menu selection and search results update only the menu. */
export function ChatMenu() {
    const menu = useBuliUiSelector(selectMenu)
    return <InputMenu menu={menu} />
}

const selectMenu = (snapshot: IBuliUiSnapshot) => snapshot.menu
