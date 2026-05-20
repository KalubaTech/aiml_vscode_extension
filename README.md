# AIML — VS Code Extension

An AI-native development assistant powered by the AIML orchestration platform.
The extension is a thin client; all reasoning, rules, memory, and tool-routing
happens on AIML.

## What it does

- **Sidebar chat** scoped to your current AIML project.
- **Agentic tool use** — the AI can read files, list the workspace, check
  diagnostics, open files, propose edits with a refactor preview, and run
  terminal commands (with your approval).
- **Editor commands** — Explain / Refactor / Optimize / Generate tests /
  Document a selection; Fix problems in the current file.
- **Project-aware**: every request goes through AIML, so your rules, memory,
  RAG documents, and personality apply automatically.
- **Multi-model ready**: AIML picks the model (Claude today, GPT/Gemini/local
  later). Internal handlers (math, time, greeting, currency, …) answer for
  free.

## Install (from source, dev loop)

```bash
cd vscode-extension
npm install
npm run compile
```

Then in VS Code:

1. **Run Extension** → press `F5` (or use the "Extension Development Host"
   debug config). A new VS Code window opens with the extension loaded.
2. In that window: `⌘⇧P` → **AIML: Configure** → paste your endpoint, API key
   and project ID (find both in the AIML dashboard → Developers / Projects).
3. Click the **AIML** icon in the activity bar to open the chat.

## Package as a `.vsix`

```bash
npm install -g @vscode/vsce
cd vscode-extension
npm install
npm run compile
vsce package --no-dependencies
```

Then `code --install-extension aiml-vscode-0.1.0.vsix`.

## Configuration

| Setting | Default | Notes |
| --- | --- | --- |
| `aiml.endpoint` | `https://dev-finance.eagle-pay.com/aiml` | Base URL, no trailing `/v1`. |
| `aiml.apiKey` | — | Bearer key from **Dashboard → Developers**. Treat as a secret. |
| `aiml.projectId` | — | From **Dashboard → Projects** (click the ID column to copy). |
| `aiml.defaultModel` | _project default_ | Override the project's default model for this client. |
| `aiml.maxAgentSteps` | `12` | Maximum tool-use rounds per turn before the agent gives up. |
| `aiml.autoApproveReads` | `true` | Auto-approve `read_file`, `list_workspace`, `get_diagnostics`, `get_open_files`. Writes always ask. |
| `aiml.includeOpenFiles` | `true` | Pass open file paths as extra context. |

## Tools the AI can invoke

| Tool | Effect | Confirmation? |
| --- | --- | --- |
| `read_file` | Returns up to 64 KB of UTF-8 text. | No |
| `list_workspace` | Glob-search up to 500 paths, excludes `node_modules` etc. | No |
| `get_open_files` | List of paths of open editor tabs. | No |
| `get_active_selection` | Selected text + file path + range. | No |
| `get_diagnostics` | Errors/warnings reported by language servers. | No |
| `apply_edit` | Find/replace or whole-file write. | **Yes** — modal with Apply / Show diff / Reject |
| `open_file` | Reveal a file in an editor tab. | No |
| `run_terminal` | Execute a shell command in a managed VS Code terminal. | **Yes** — modal warning |

## How the agentic loop works

1. You send a message.
2. The extension POSTs to `https://<endpoint>/v1/chat` with `tools[]`
   declaring everything in the table above.
3. AIML decides if any internal fast-path applies (math, time, RAG
   passthrough, …) — if so, replies in 0 ms with no tokens.
4. Otherwise AIML asks Claude. If Claude wants a tool, AIML returns
   `stopReason: "tool_use"` + `toolCalls[]`.
5. The extension executes each tool locally and posts `toolResults` back.
6. Steps 3–5 repeat until `stopReason === "end_turn"` (or
   `aiml.maxAgentSteps` is hit).

Every server-side rule (PRE/POST/BLOCK/REDACT/WARN) still applies. Every
turn is logged in the AIML usage table.

## Privacy & security

- The API key is stored in VS Code's machine-scoped settings.
- File contents go to AIML only when the agent calls `read_file` (or you
  paste them). Listing only returns paths.
- Writes always show a refactor preview before applying.
- Terminal commands always require a modal confirmation.
- The AIML server holds your rules, memory, and conversation history. Delete
  any of them from the dashboard if you change your mind.

## Troubleshooting

- **"API key not configured"** → `⌘⇧P` → **AIML: Configure**.
- **`HTTP 401 invalid_api_key`** → the key was revoked. Create a new one in
  the dashboard → Developers tab.
- **`HTTP 402 subscription_inactive`** → your AIML subscription needs renewal.
  Open the dashboard from the chat or with **AIML: Sign in / open dashboard**.
- **`HTTP 403 forbidden`** → the API key's project belongs to a different
  organization than its key. Make sure the project ID lines up with the key.
- **Tool calls don't appear** → check that the project's `defaultModel` is a
  valid Claude model. The dropdown on the AIML dashboard ensures this.
