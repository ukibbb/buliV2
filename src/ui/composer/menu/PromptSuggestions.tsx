import { PromptSuggestionsList } from "@/ui/composer/menu/PromptSuggestionsList"
import { useBuliUiSelector } from "@/ui/context/ui-controller-context"
import type { IBuliUiSnapshot } from "@/ui/controller/ui-controller"

/** Menu selection and search results update only the menu. */
export function PromptSuggestions() {
    const menu = useBuliUiSelector(selectMenu)
    return <PromptSuggestionsList menu={menu} />
}

const selectMenu = (snapshot: IBuliUiSnapshot) => snapshot.menu
