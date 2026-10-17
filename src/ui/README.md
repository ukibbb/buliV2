# Terminal UI map

This directory contains the terminal presentation layer. Application operations
belong to `src/app`; session state and durable history belong to `src/sessions`.
UI components subscribe to those services rather than maintaining copies of
session state.

## Directories

| Directory | Responsibility | Start here |
| --- | --- | --- |
| `entrypoints/` | Connect application startup or standalone authentication to the terminal renderer. | `run-main-tui.tsx`, `run-authentication-tui.tsx` |
| `startup/` | Show startup, startup failure, or the connected application; create and dispose the UI controller. | `ApplicationStartup.tsx` |
| `screens/` | Select the active screen and compose its layout. | `ApplicationScreen.tsx`, `HomeScreen.tsx`, `SessionScreen.tsx` |
| `composer/` | Compose prompt input, suggestions, queued messages, and session/model status. | `MessageComposer.tsx` |
| `composer/prompt/` | Edit resource-aware drafts, handle attachments, and connect the editor to the controller. | `SessionPromptInput.tsx`, `PromptEditor.tsx`, `prompt-draft.ts` |
| `composer/menu/` | Render prompt suggestions and their selection. | `PromptSuggestions.tsx`, `PromptSuggestionsList.tsx` |
| `composer/queue/` | Render pending steering and follow-up messages. | `SessionMessageQueue.tsx`, `QueuedMessagesList.tsx` |
| `composer/status/` | Render model readiness, environment indicators, run activity, and errors. | `ModelStatus.tsx`, `SessionEnvironmentStatus.tsx`, `SessionRunActivity.tsx` |
| `controller/` | Own UI state and coordinate draft editing, submission, navigation, command menus, and path suggestions. | `ui-controller.ts`, `ui-state-store.ts`, `prompt-submission.ts` |
| `context/` | Expose application/controller instances and narrowly selected snapshots to React components. | `application-context.tsx`, `ui-controller-context.tsx` |
| `conversation/history/` | Load history pages, preserve viewport position, and assemble historical and streaming conversation content. | `SessionConversationHistory.tsx`, `conversation-history-controller.ts`, `ConversationMessages.tsx`, `conversation-blocks.tsx` |
| `conversation/messages/` | Render assistant message parts, Markdown, and reasoning. | `AssistantMessagePart.tsx`, `MarkdownContent.tsx`, `ReasoningContent.tsx` |
| `conversation/tools/` | Match tool results to calls, prepare display arguments, render calls/results and file diffs, and limit fallback previews. | `tool-call-matching.ts`, `tool-call-presentation.ts`, `ToolCallDisplay.tsx`, `FileChangeDiff.tsx` |
| `conversation/delegation/` | Render delegated task results and their nested conversation history. | `DelegatedTaskDisplay.tsx` |
| `commands/` | Define built-in commands, command contracts, and picker panels. | `builtin-commands.ts`, `command-contracts.ts`, `CommandPanel.tsx` |
| `authentication/` | Coordinate and render the shared login/logout flow. | `AuthenticationFlow.tsx`, `authentication-flow-controller.ts` |
| `keyboard/` | Define application, prompt, and menu shortcut bindings. Authentication has its own local bindings. | `application-shortcuts.ts` |
| `notifications/` | Observe session completion and notify through the terminal. | `SessionCompletionNotifier.tsx` |
| `components/` | Share presentation elements and selection scrolling across UI features. | `MessageCard.tsx`, `ErrorNotice.tsx`, `use-selection-scroll.ts` |
| `terminal/` | Own renderer integration, viewport primitives, clipboard integration, parsers, assets, and theme. | `renderer/run-tui-renderer.ts`, `TerminalViewport.tsx`, `theme.ts` |

Tests live in a `tests/` directory next to their owning feature. Cross-cutting
terminal integration tests also live in the repository's root `tests/` directory.

## From a keypress to a rendered response

1. `PromptEditor` handles keyboard input and emits an updated draft or a submit
   request. `SessionPromptInput` connects those callbacks to `BuliUiController`.
2. The controller owns the current draft and coordinates UI actions. Its
   `BuliPromptSubmission` collaborator distinguishes commands, normal prompts,
   steering, and follow-up messages, then calls the application service.
3. For a normal prompt, submission waits for `promptPersisted` before consuming
   the submitted draft. A newer draft must not be erased when an older submission
   finishes. Completion of the model response is a separate promise.
4. Application/session services publish snapshots. Context hooks and selectors
   subscribe to the fields each section needs; the screen itself only composes
   those sections.
5. `SessionConversationHistory` connects a history controller to the active
   session or delegated task. The controller selects the latest or an archived
   page. The component owns terminal scroll references and viewport anchoring.
6. `ConversationMessages` and `conversation-blocks.tsx` assemble messages,
   compaction summaries, and live content. Message, tool, and delegation components
   render those blocks. Tool matching associates outcomes with calls; tool
   presentation prepares labels and arguments before the memoized view renders.

## Ownership and change boundaries

- `BuliUiController` and `BuliUiStateStore` own UI navigation, menus, errors, and
  draft-related coordination. React contexts expose them; contexts are not a
  second state store.
- Session services own messages, active runs, queues, and persisted history.
  Composer and conversation sections subscribe independently.
- History navigation state belongs to `ConversationHistoryController`; terminal
  viewport references belong to `SessionConversationHistory`.
- Authentication uses its existing flow controller in both standalone and
  in-application entrypoints.
- Renderer lifetime, parser assets, and clipboard integration remain under
  `terminal/`. Presentation refactors must not silently change their lifetime.
- Delegated task rendering intentionally reuses `SessionConversationHistory`.
  This creates a recursive composition through the conversation block renderer;
  moving files does not remove that dependency.
- Component names describe responsibilities. Terminal element IDs and visible
  labels are independent interfaces and need not match file names.
