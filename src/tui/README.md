# TUI architecture

The terminal UI is grouped by ownership rather than by React primitive.

## `host/`

`run-tui-renderer.ts` owns the OpenTUI renderer, the React root and the root
`Lifetime`. It creates platform resources and guarantees their cleanup. It does
not know application screens or authentication providers.

`open-url.ts` is a platform adapter. Authentication receives this operation as
a dependency, so its controller and view do not import operating-system APIs.

## `app/`

This folder contains the shell of the main Buli application. `BuliUiController`
is the single owner of presentation state such as route, draft, menus and the
authentication overlay. `ui-controller-context.tsx` only connects that external
store to React through `useSyncExternalStore`; it is not a second state store.

`commands.ts` defines available commands and their effects. Keeping the catalog
outside the controller lets the controller focus on invocation, navigation and
safe consumption of input.

Application keyboard shortcuts are declarative configuration over the shared
`KeyboardShortcutResolver`; components keep only state-dependent routing.

## `keyboard/`

`KeyboardShortcutResolver` performs exact key and modifier matching. It owns no
UI state and knows no application actions; each feature supplies its own typed
scope/action table.

## `authentication/`

`AuthenticationFlowController` owns the authentication state machine, operation
IDs, cancellation and the pending prompt Promise. `AuthenticationFlow.tsx` owns
only OpenTUI rendering, keyboard routing, focus and scroll references.
`use-authentication-flow.ts` owns the local React binding: controller creation,
`useSyncExternalStore`, startup and disposal. A Context is intentionally not
used because one authentication screen has one controller consumer.

Authentication shortcuts use the same resolver as the application, with a
feature-local action table for accept, cancel and scrolling.

The controller depends on `IAuthenticationService`, never on OpenAI or file
storage. The same flow can therefore run as an overlay in the main application
or as the standalone `buli login` / `buli logout` screen.

## Shutdown

Entrypoints compose concrete dependencies. The root `Lifetime` aborts first,
then waits for the application/authentication owner, React unmount and renderer
cleanup. Controllers stop publishing after disposal, while services wait for
their active asynchronous operations to release resources.
