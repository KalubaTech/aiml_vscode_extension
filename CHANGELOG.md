# Changelog

All notable changes to the AIML VS Code extension are documented here.

## 0.2.6 — 2026-05-20

### Fixes

- **Session history popover now actually appears.** The history clock
  icon ⌚ was wired correctly but the popover element was inheriting
  `bottom: calc(100% - 2px)` and `left: 12px` from the shared `.popover`
  base class, which combined with its own `top: 42px` collapsed it to
  a zero/negative height — so clicking the button looked like a no-op.
  The override now resets `left` and `bottom` and bumps `z-index` to
  match the other popovers, so previous sessions show as expected.

## 0.2.5 — 2026-05-17

### Changes

- **Enter sends, Shift+Enter inserts a newline.** The composer now
  matches the convention used by Slack, Discord and ChatGPT. The
  old Cmd/Ctrl+Enter shortcut continues to send (one less surprise
  during muscle-memory transitions). IME composition is respected,
  so CJK input methods are unaffected.

## 0.2.4 — 2026-05-17

### Features

- **AIML can now plan with a todo list.** A new `todo_write` tool
  lets the agent declare a structured plan and check items off as it
  works. The list renders as a pretty checklist in the chat: pending
  items show ☐, the one currently in progress shows a pulsing ◐ with
  the present-continuous label ("Adding login endpoint…"), completed
  items show ☑ struck-through. The summary row shows a `done / total`
  pill, and the frame is collapsible. Each `todo_write` call writes
  a fresh snapshot of the list, so history is preserved as the plan
  evolves.

## 0.2.3 — 2026-05-17

### Fixes

- **Snake animation now actually follows the border.** The previous
  conic-gradient implementation rotated a pie-slice around the
  composer's centre, which leaked colour streaks well outside the
  textarea. Replaced with an SVG `<rect>` driven by an animated
  `stroke-dashoffset`, so a single bright segment traces the
  perimeter cleanly while the agent is processing.

## 0.2.2 — 2026-05-17

### Fixes

- **Selected model is now actually used.** The extension previously
  stored the user's chosen model (Haiku / Sonnet / Opus) in the
  profile but did not forward it to the AIML API, so the server
  always fell back to the project default — leaving users seeing
  Opus responses when they had Haiku selected. The `model` field is
  now sent on every `/v1/chat` request and takes precedence over the
  project default.

## 0.2.1 — 2026-05-17

### Features

- **Auto-apply edits with one-click revert.** File edits and file
  creates no longer block on an Apply / Reject prompt — they land
  immediately. The tool frame shows a green "Edited \`path\`" or
  "Created \`path\`" card with a **↶ Revert** button that restores
  the previous content (or deletes the file if it was newly created).
  You can also use VS Code's normal undo if you have the file open.
  Terminal commands still require approval.
- **Animated "snake" border while thinking.** A subtle conic-gradient
  highlight runs around the composer textarea whenever the agent is
  processing a turn — the same idiom Copilot uses to signal an
  in-flight request. Falls back to a soft pulse on renderers that
  don't support `mask-composite`.

## 0.2.0 — 2026-05-17

### Features

- **Session header on top.** A Claude-Code-style header sits above the
  conversation with the current session title, a history clock icon
  ⌚ that opens a recent-sessions popover, and a ＋ icon to start a
  fresh session. Switching sessions restores the saved transcript;
  deleting one keeps you in the current session.
- **Sticky latest user message.** When you scroll through a long
  agent run, the most recent user prompt now sticks to the top of the
  message list so you can always see what you asked for. Only the
  newest user bubble is pinned — older ones scroll normally.
- **In-chat tool approval.** Edit and terminal approvals no longer
  pop a VS Code modal. The tool frame opens in place and shows an
  approval card with **Apply / Show diff in editor / Reject** for
  edits, or **Run / Cancel** for terminal commands. The diff preview
  is rendered inline so you can decide without leaving the chat.
- **Progress stepper.** When the agent runs a multi-step turn, a thin
  progress bar above the composer shows `step N / max · thinking…`
  so you can see exactly where the agent is in its tool loop.
- **Multi-session storage.** Previous conversations are kept in
  workspace state (capped at 30 sessions). The history popover lets
  you switch between them or trash old ones.

## 0.1.10 — 2026-05-16

### Features

- **AIML now defaults to the right-side (auxiliary) sidebar.** On the first
  activation after install/update, the extension programmatically moves its
  chat view to the auxiliary side bar where dedicated AI assistants
  normally live (next to Copilot Chat / Claude Code when those are also
  pinned there). The placement is remembered in `globalState` so the
  extension doesn't fight you if you later move it elsewhere.
- New command **`AIML: Move chat to right side bar`** for explicit
  invocation. Useful if you reset your view layout or accidentally hide
  the auxiliary bar.

### Notes

- VS Code does not expose `auxiliarybar` as a `viewsContainers` target,
  so this is done at runtime via VS Code's internal move-view command.
  The exact command name has shifted between editor versions, so the
  extension tries several variants and silently falls back to the
  registered location if none apply. Worst case, drag the AIML tab to
  the right-side bar once and VS Code will remember it.

## 0.1.9 — 2026-05-16

### Features

- **Live "active editor" context.** The file currently open in your editor
  appears as a special chip above the composer (with a green pulse). Every
  message you send includes it as context so the agent always knows what
  you're looking at. Switch files → the chip auto-updates. Make a selection
  → the chip shows the line range. Toggle it off with the chip's `×` when
  you want a "clean" question.
- **Session persistence.** Your chat history is saved into VS Code's
  workspace state (per-workspace, machine-local) and restored automatically
  the next time you open the workspace, along with the `conversationId` so
  the AIML server-side conversation continues seamlessly. A banner labels
  the restored history; click **Reset** to start fresh. Sessions are
  scoped per-project — switching profile / project clears the slot.

## 0.1.8 — 2026-05-16

### Fixed

- **Attach + overflow popovers were always visible.** A `display: flex`
  rule was overriding the `hidden` HTML attribute, so neither popover ever
  disappeared. Added a `[hidden] { display: none !important; }` reset so
  the attribute wins.

## 0.1.7 — 2026-05-16

### Features

- **Responsive composer footer.** When the panel is too narrow, buttons
  collapse one by one (profile → save → configure → reset) into a `⋯`
  overflow menu. The essential controls (attach `＋`, model pill, send `↑`)
  always stay visible.
- **Inline workspace file picker** (Claude-Code style). The `＋` button now
  opens a popover above the composer with:
  - **Upload from computer** — pick any file from disk; its text content
    is read (up to 64 KB) and inlined into the next message as a code block.
  - **Add context** — filterable list of workspace files (excludes
    `node_modules`, `.git`, `dist`, etc.). Pick one or more, each becomes a
    chip above the composer.
- **Search-as-you-type** in the workspace picker — uses
  `vscode.workspace.findFiles` paginated on every keystroke.
- **Click-outside to dismiss** both popovers; `Escape` also closes them.

## 0.1.6 — 2026-05-16

### Fixed

- **Sign-in error finally eliminated.** Profiles now live in the extension's
  own `globalState` (metadata) and `SecretStorage` (API keys) rather than
  user-settings JSON. No more "Unable to write to User Settings because
  aiml.profiles is not a registered configuration" — there's nothing to
  register anymore. API keys are stored in the OS keychain (Credential
  Manager / Keychain / libsecret) so they never appear in JSON or Settings
  Sync. Existing single-key configurations migrate automatically on first
  activation.

## 0.1.5 — 2026-05-16

### Fixed

- **Sign-in failure** ("Unable to write to User Settings because aiml.profiles
  is not a registered configuration"). The new multi-profile fields are now
  properly declared in the contribution schema.

### Features

- **Composer footer (Claude-Code style):** a single row beneath the textarea
  exposes "Attach file", a model pill, a profile pill, "Save conversation",
  "Reset", and "Configure" as compact icon buttons. The send button is now a
  circular arrow on the right.
- **Attach file context:** click `＋` to pick workspace files. Selected files
  appear as chips above the textarea; the next message is prefixed with their
  paths so the agent reads them on demand. Chips clear after a successful
  turn and can be removed with the `×` button.
- **Save conversation to local Markdown.** New `AIML: Save conversation to
  file` command (and `⤓` icon in the composer footer) saves the entire
  transcript — user messages, AIML replies, tool calls, tool results,
  warnings — as a clean Markdown document.
- **Inline warnings** when the assistant returns `warnings[]` or the request
  was blocked by a rule.
- **Editor title bar uses icons** (save / clear / model / profile / configure
  / sign-in) instead of text labels, matching the rest of the VS Code chrome.
- **Live profile and model pills** in the footer; click either to open the
  matching quick-pick.

## 0.1.4 — 2026-05-16

### Features

- **Multi-account profile switcher.** The extension now stores one or more
  AIML accounts side by side. `AIML: Switch profile` opens a quick pick;
  signing in again adds another profile rather than overwriting. Removing a
  profile signs out locally without revoking the key.
- **Status bar item** in the bottom-right: shows active profile, current
  model (e.g. *Opus 4.7*), and running session token totals. Click to open
  a menu (switch model, switch profile, reset, open chat, sign out, etc.).
- **Model switcher**: `AIML: Switch model` (or via the status-bar menu)
  shows the live model catalogue and updates the active profile's default.
- **Token usage indicator**: the status bar surfaces in/out tokens for the
  current conversation; resets on `Reset conversation`.
- **Chat UI polish** to match Claude Code's style:
  - Collapsible tool-use frames (closed by default, expand to see input +
    result).
  - Proper markdown rendering — headings, lists, blockquotes, bold/italic,
    links, fenced code with **hover-to-copy** buttons.
  - Per-message hover actions: pencil button on user messages re-loads the
    text into the composer so you can edit-and-resend.
  - Improved error banner for unconfigured sessions.

### API

- New endpoint `GET /v1/models` (Bearer auth) — returns the list of
  foundation models the platform supports. Used by the model switcher.

## 0.1.3 — 2026-05-16

### Features

- **Sign in with AIML** (OAuth-style). A new `AIML: Sign in` command opens
  your browser to the AIML authorize page, you pick a project, click
  Approve — the editor receives the credentials via a registered URI
  handler and saves them automatically. No more copy-pasting API keys.
- **AIML in the bottom panel.** The extension now also registers itself as
  a chat-panel container, so the AIML icon shows up next to **CHAT** and
  **CLAUDE CODE** at the bottom of the editor.
- **Full "AIML" monogram** for the activity-bar icon (renders identically
  across themes; replaces the previous bracket-A mark).
- New commands: `AIML: Sign out`, `AIML: Open dashboard in browser`.
- Welcome view now leads with **Sign in to AIML** as the primary CTA;
  manual configure remains as a fallback.

## 0.1.2 — 2026-05-16

### Fixed

- Activity-bar icon now renders as a proper monochrome mark. The previous
  full-color PNG was being collapsed to a gray silhouette by VS Code's
  activity-bar tinting. Replaced with an SVG that uses `currentColor`, so
  the icon adapts to dark / light / high-contrast themes.

## 0.1.1 — 2026-05-16

### Improvements

- **New configuration UI.** `AIML: Configure` now opens a polished webview
  panel with all settings in one form, a "Test connection" action that
  pings the platform and lists projects, a project-picker dropdown that
  autofills the project ID from discovered projects, and a "show/hide"
  toggle for the API key. Replaces the older sequential prompt flow.
- **Welcome view in the sidebar** when AIML isn't configured yet — single
  click to open the configuration panel, sign-up link to the dashboard.
- Polished onboarding nudge after install.

## 0.1.0 — 2026-05-15

### Initial release

- Sidebar chat view (webview) scoped to your current AIML project.
- Agentic tool loop driven by AIML's `/v1/chat` Anthropic-shaped contract:
  - `read_file`, `list_workspace`, `get_open_files`, `get_active_selection`,
    `get_diagnostics`
  - `apply_edit` (with a refactor preview and Apply / Show diff / Reject
    confirmation)
  - `open_file`
  - `run_terminal` (modal warning required to run)
- Editor commands: Explain / Refactor / Optimize / Generate tests / Document
  for the current selection; Fix problems in the current file.
- Configuration wizard (`AIML: Configure`) for endpoint, API key, project ID,
  and default model.
- Automatic onboarding nudge when the API key isn't configured.
- Subscription-aware: surfaces `subscription_inactive` and `forbidden`
  responses with actionable messages.
