# Weryfikacja narzędzi i przeniesienia UI

Data: 2026-09-17. Środowisko: macOS arm64, Bun 1.3.14, Buli 0.8.2.

## Zmiany

- Domyślna definicja Buliego zawiera `read`, `find`, `grep`, `tool_output`,
  `edit`, `write` i `bash`. Bootstrap nadal zachowuje możliwość wstrzyknięcia
  własnych narzędzi i dołączenia narzędzia wyszukiwania dostawcy.
- Prezentacja, entrypointy TUI, obsługa terminala, parsery, assety i ich licencje
  znajdują się w `src/ui`. Usunięte przez przeniesienie katalogi:
  `src/app/ui`, `src/app/entrypoints`, `src/authentication/ui`,
  `src/sessions/ui`, `src/terminal`.
- Test architektury wymusza kierunek zależności: rdzeń nie importuje UI ani
  OpenTUI. Sprawdza też importy względne i nieobecność dawnych katalogów.
- Escape przy otwartym menu wywołuje `dismissMenu()` i kończy obsługę zdarzenia.
  Kolejny Escape zachowuje przywracanie kolejki do draftu i przerywanie sesji.
  Regresję sprawdzają test kontrolera oraz test rzeczywistych zdarzeń klawiatury
  renderera OpenTUI z aktywną sesją i obiema kolejkami.
- Ścieżka licencji parserów w skrypcie dystrybucyjnym wskazuje nowe położenie.

## Faktycznie uruchomione kontrole

| Polecenie | Wynik końcowy |
| --- | --- |
| `bun run typecheck` | PASS, kod 0 |
| `bun run test` | PASS: 660 pass, 1 skip, 0 fail; 3918 asercji, 56 plików, 15,45 s |
| `bun run build:local` | PASS, kod 0; 984 moduły; `dist/buli` |
| `bun run bundle:local` | PASS, kod 0; kompilacja, podpis i weryfikacja macOS, help/version, rg/fd, archiwum i checksum |
| `git diff --check` | PASS, brak błędów |

Pominięty test dotyczy niedostępności Bash na Windows. Testy emitują ostrzeżenia
AI SDK o niewspieranych `reasoningEffort`/`reasoningSummary` w scenariuszach
modeli bez reasoning; nie powodują błędów testów.

W trakcie pracy pierwsze typechecki wykryły stare importy w `test/tui.test.ts`,
nieprawidłowo typowane kolejki w nowym teście i brak zawężenia opcjonalnego
`highlights` w skrypcie smoke. Wszystkie poprawiono. Powyżej zapisano wyniki
końcowe; ostatni typecheck wykonano także po dodaniu skryptu smoke.

Artefakty dystrybucyjne:

- `dist/buli`
- `dist/buli-darwin-arm64/bin/buli`
- `dist/buli-darwin-arm64.tar.gz`
- `dist/buli-darwin-arm64.tar.gz.sha256`

## Skompilowane parsery

Wykonano:

```bash
bun build --compile scripts/smoke-terminal-parsers.ts --outfile dist/smoke-terminal-parsers
./dist/smoke-terminal-parsers ./dist/buli ./dist/buli-darwin-arm64/bin/buli
```

Wynik, kod 0:

```text
./dist/buli: all four Bash/Python assets embedded
./dist/buli-darwin-arm64/bin/buli: all four Bash/Python assets embedded
python: highlighting OK (10 captures)
bash: highlighting OK (6 captures)
shell: highlighting OK (1 captures)
Parser smoke test passed with a fresh, unpopulated parser cache
```

Skrypt uruchamia skompilowany kod rejestracji parserów i worker OpenTUI z nowym
katalogiem cache, bez pobranych parserów/zapytań. Porównuje również zawartość
wszystkich czterech assetów z bajtami obu rzeczywistych binarek aplikacji.
To sprawdzenie uzupełnia kompilację i test parserów ze źródeł; nie jest wizualną
oceną kolorów w terminalu.

## Smoke test interfejsu

`bun run dev` uruchomiono bezpośrednio: aplikacja wyrenderowała startup i ekran
główny. Pierwsza próba została zakończona limitem narzędzia po 12 sekundach.
Następnie uruchomiono źródła oraz binarkę paczki w pseudoterminalu 120×30
za pomocą lokalnego sterownika `_temp/smoke-ui.py`:

```bash
python3 _temp/smoke-ui.py bun run dev
python3 _temp/smoke-ui.py ./dist/buli-darwin-arm64/bin/buli
```

Obie próby zakończyły się kodem 0 i wynikami:

```text
Startup and home frame: OK
Login provider/method navigation and Escape back/close: OK
Logout confirmation and Escape back/close: OK (connection retained)
Ctrl+C shutdown: OK, exit 0
```

Sterownik obserwuje wyjście terminala i wysyła klawisze. Nie zastępuje ręcznej
oceny interfejsu. Nie kończono logowania OAuth ani nie zatwierdzano wylogowania.

| Punkt checklisty | Wykonana weryfikacja | Co pozostało ręcznie |
| --- | --- | --- |
| 1. Start i ekran główny | Źródła i binarka: PTY PASS | Ocena wizualna w terminalu użytkownika |
| 2. Prompt i transkrypt | Testy TUI/runtime/modeli PASS | Prompt do rzeczywistego modelu i obserwacja odpowiedzi |
| 3. Menu podczas odpowiedzi | Test renderera OpenTUI z aktywną sesją PASS | Menu podczas rzeczywistego streamingu |
| 4. Pierwszy Escape | Testy kontrolera i klawiatury: menu zamknięte, draft/kolejki/snapshot zachowane, brak abort | Potwierdzenie podczas rzeczywistej odpowiedzi |
| 5. Drugi Escape | Test klawiatury: przywrócona kolejka, jedno wywołanie abort | Zatrzymanie rzeczywistej odpowiedzi |
| 6. Login/logout i cofanie | PTY: wybór dostawcy/metody, potwierdzenie logout i cofanie; testy auth PASS | Pełny OAuth i zatwierdzone wylogowanie |
| 7. Clipboard, zaznaczanie, scroll | Testy clipboard, edytora, transkryptu i scrollowania PASS | Schowek systemowy, mysz, zaznaczanie i scroll w terminalu |
| 8. Podświetlanie kodu | Testy źródłowe i skompilowany probe Bash/Python/shell PASS; assety w obu binarkach | Wizualne podświetlenie w transkrypcie |
| 9. Zamknięcie podczas startup/auth | Testy lifetime, rollbacku startupu i anulowania/dispose auth PASS; normalne zamknięcie PTY PASS | Zamknięcie rzeczywistej aplikacji podczas startupu i aktywnego OAuth |

## Status zakończenia

Implementacja, testy automatyczne, build lokalny i paczka dystrybucyjna zostały
zweryfikowane. Testy nie wykazały regresji innych zachowań. Pełny ręczny smoke
test z checklisty pozostaje do wykonania; nie należy oznaczać go jako zaliczony
na podstawie samych testów automatycznych i PTY.
