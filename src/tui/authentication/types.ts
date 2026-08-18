// Mode i outcome opisują ekran/komendę TUI, a nie możliwości backendowego
// providera. Trzymamy je przy workflow, aby auth core nie znał nawigacji UI.
export type TAuthenticationMode = "login" | "logout"
export type TAuthenticationOutcome = "success" | "cancelled" | "failure"
