import { realpath } from "node:fs/promises"
import { isAbsolute, resolve, sep } from "node:path"

import type { IAgentTool } from "@/agent/agent-types"
import { truncateToolOutput } from "@/agent/tool-output"

export function createWorkspaceTools(
    workspaceRoot: string,
): readonly IAgentTool[] {
    const readFile: IAgentTool = {
        name: "read_file",
        description: "Read a UTF-8 file from the current workspace.",
        inputSchema: {
            type: "object",
            properties: {
                path: {
                    type: "string",
                    description: "Path relative to the current workspace",
                },
            },
            required: ["path"],
            additionalProperties: false,
        },
        execute: async (input, context) => {
            const path = requireString(input, "path")
            // ?? How abort singal works overall and how in this contexT?
            // `AbortController` anuluje operację, a odbiorcy dostają jego
            // `AbortSignal`. Sam sygnał nie zatrzymuje dowolnego kodu automatycznie:
            // kod musi go sprawdzać albo przekazać do API, które obsługuje anulowanie.
            // Tutaj jest to sygnał bieżącego uruchomienia Agenta, przekazany do
            // każdego narzędzia. `throwIfAborted()` nic nie robi przed anulowaniem,
            // a po nim rzuca `signal.reason`, więc ten `async execute` odrzuca Promise.
            // Pierwsze sprawdzenie nie pozwala zacząć pracy po wcześniejszym abort.
            // `realpath` i `Bun.file(...).text()` nie dostają tutaj sygnału, więc nie
            // zostaną przerwane w trakcie; ostatnie sprawdzenie tylko nie pozwoli
            // zwrócić wyniku po anulowaniu. Brakuje checkpointu pomiędzy tymi awaitami.
            //
            context.signal.throwIfAborted()
            const file = await realpath(resolve(workspaceRoot, path))

            if (!file.startsWith(`${workspaceRoot}${sep}`)) {
                throw new Error("Path is outside the current workspace")
            }

            // overall I can't return more than 100_000 chars
            // Wspólny limiter liczy teraz 100 000 bajtów UTF-8 i 2000 linii.
            // Nadal wywołujemy go tutaj, aby chronić także bezpośrednie użycie toola
            // poza pętlą agenta; centralny limiter w pętli jest idempotentny.
            const contents = await Bun.file(file).text()
            context.signal.throwIfAborted()
            return limitToolOutput(contents)
        },
    }

    const glob: IAgentTool = {
        name: "glob",
        description: "Find files in the current workspace using a glob pattern.",
        inputSchema: {
            type: "object",
            properties: {
                pattern: {
                    type: "string",
                    description: "Relative glob pattern, for example **/*.ts",
                },
            },
            required: ["pattern"],
            additionalProperties: false,
        },
        execute: async (input, context) => {
            const pattern = requireString(input, "pattern")
            context.signal.throwIfAborted()

            // ?? How this if statment works
            // `isAbsolute(pattern)` odrzuca ścieżkę absolutną. Operator `||` działa
            // short-circuit: jeśli lewy warunek jest prawdziwy, prawy nie jest liczony.
            // W przeciwnym razie `split(/[\\/]/)` dzieli wzorzec po `\` albo `/`,
            // a `includes("..")` wykrywa dokładny segment przejścia do katalogu rodzica.
            // Jeśli wystąpi którykolwiek przypadek, `throw` kończy wykonanie narzędzia.
            if (isAbsolute(pattern) || pattern.split(/[\\/]/).includes("..")) {
                throw new Error("Glob pattern must stay inside the workspace")
            }

            const files: string[] = []

            // how this works line by line ?
            // `new Bun.Glob(pattern)` kompiluje wzorzec, a `scan` zwraca asynchroniczny
            // iterator znalezionych ścieżek. `cwd` ustawia katalog startowy,
            // `onlyFiles` pomija katalogi, `dot` pomija ukryte nazwy, a
            // `followSymlinks` zabrania schodzenia do katalogów przez symlinki.
            // `for await` pobiera kolejne względne ścieżki bez ładowania całej listy.
            // Przy każdym wyniku sprawdzamy abort, dzielimy ścieżkę na segmenty
            // i przez `continue` pomijamy `.git` oraz `node_modules`.
            // Pozostałe pliki trafiają do tablicy; `break` zatrzymuje skan po 100.
            // Końcowy checkpoint wykrywa abort także po zakończeniu lub pustym skanie.
            // `join("\n")` zwraca po jednej ścieżce na linię, `||` daje komunikat dla
            // pustej tablicy, a `limitToolOutput` pilnuje limitu długości odpowiedzi.
            for await (const file of new Bun.Glob(pattern).scan({
                cwd: workspaceRoot,
                onlyFiles: true,
                dot: false,
                followSymlinks: false,
            })) {
                context.signal.throwIfAborted()
                const segments = file.split(/[\\/]/)
                if (segments.includes(".git") || segments.includes("node_modules")) {
                    continue
                }

                files.push(file)
                if (files.length === 100) break
            }

            context.signal.throwIfAborted()
            return limitToolOutput(files.join("\n") || "No files found")
        },
    }

    // ?? how this works line by line
    // To definicja narzędzia `grep`: nazwa i opis są widoczne dla modelu, a
    // `inputSchema` deklaruje obiekt z wymaganym, niepustym stringiem `pattern`.
    // `execute` pobiera ten argument, sprawdza jego typ, abort i pusty tekst.
    // `Bun.spawn` uruchamia `rg` bez powłoki, więc każdy element tablicy jest osobnym
    // argumentem. `--no-config` ignoruje konfigurację użytkownika, `--line-number`
    // dodaje numery linii, `--no-heading` usuwa nagłówki plików, a `--color=never`
    // wyłącza kody kolorów. Dwa `--glob=!...` wykluczają `.git` i `node_modules`.
    // `--` kończy listę opcji, dzięki czemu wzorzec zaczynający się od `-` nie jest
    // flagą; po nim `pattern` jest regexem ripgrep, a `.` oznacza cały workspace.
    // `cwd` ustawia katalog procesu, stdin jest zamknięte, a stdout i stderr trafiają
    // do potoków. `AbortSignal.any` anuluje proces po abort bieżącego runu albo po 10 s.
    // `Promise.all` równolegle opróżnia oba potoki i czeka na kod zakończenia procesu.
    // Dla ripgrep kod 1 oznacza brak dopasowań, 0 sukces, a pozostałe kody błąd.
    // Udany stdout jest dzielony na linie i obcinany do 100; jeśli wyników było więcej,
    // dodawany jest marker. Na końcu `limitToolOutput` stosuje limit znaków.
    // Ograniczenie: stdout i stderr są w całości buforowane przed obcięciem, a timeout
    // może zostać pokazany jako ogólny błąd procesu zamiast czytelnego `TimeoutError`.
    const grep: IAgentTool = {
        name: "grep",
        description: "Search workspace file contents using a regular expression.",
        inputSchema: {
            type: "object",
            properties: {
                pattern: {
                    type: "string",
                    minLength: 1,
                    description: "Regular expression to search for",
                },
            },
            required: ["pattern"],
            additionalProperties: false,
        },
        execute: async (input, context) => {
            const pattern = requireString(input, "pattern")
            context.signal.throwIfAborted()
            if (!pattern) throw new Error("Search pattern cannot be empty")

            const searchProcess = Bun.spawn([
                "rg",
                "--no-config",
                "--line-number",
                "--no-heading",
                "--color=never",
                "--glob=!**/.git/**",
                "--glob=!**/node_modules/**",
                "--",
                pattern,
                ".",
            ], {
                cwd: workspaceRoot,
                stdin: "ignore",
                stdout: "pipe",
                stderr: "pipe",
                signal: AbortSignal.any([
                    context.signal,
                    AbortSignal.timeout(10_000),
                ]),
            })

            const [stdout, stderr, exitCode] = await Promise.all([
                new Response(searchProcess.stdout).text(),
                new Response(searchProcess.stderr).text(),
                searchProcess.exited,
            ])

            if (exitCode === 1) return "No matches found"
            if (exitCode !== 0) {
                throw new Error(
                    stderr.trim() || `ripgrep failed with exit code ${exitCode}`,
                )
            }

            const matches = stdout.trimEnd().split("\n")
            const visibleMatches = matches.slice(0, 100)

            if (matches.length > visibleMatches.length) {
                visibleMatches.push("... results truncated")
            }

            return limitToolOutput(visibleMatches.join("\n"))
        },
    }

    return [readFile, glob, grep]
}

function requireString(input: Record<string, unknown>, key: string): string {
    const value = input[key]
    if (typeof value !== "string") {
        throw new TypeError(`Tool input ${key} must be a string`)
    }

    return value
}

function limitToolOutput(output: string): string {
    return truncateToolOutput(output)
}
