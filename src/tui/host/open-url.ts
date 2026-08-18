import open from "open"

/** Platform adapter kept outside the authentication state machine and view. */
export function openExternalUrl(url: string): Promise<unknown> {
    return open(url)
}
