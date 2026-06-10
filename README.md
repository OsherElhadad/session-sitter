# Claude Session Switcher

A lightweight VS Code extension that adds a **tabbed session browser** to the Secondary Sidebar — so you can switch between Claude Code sessions with a single click instead of hunting through the Command Palette.

![Claude Session Switcher tab strip](docs/screenshot-placeholder.png)

---

## Why This Exists

Claude Code supports multiple sessions, but switching between them requires navigating menus or remembering keyboard shortcuts. If you work across several projects or keep long-running conversations, context-switching becomes friction.

This extension puts all your sessions in a persistent tab strip — always visible, always one click away.

---

## Features

- **Session tabs** — every Claude Code session appears as a named tab, showing the first message and the project it belongs to
- **Live updates** — new sessions appear automatically the moment they're created (no refresh needed)
- **One-click switching** — click any tab to immediately open that session in Claude Code
- **Tab management** — close tabs you're done with; session data is never deleted
- **New session button** — start a fresh Claude Code session directly from the panel
- **Theme-aware UI** — automatically adapts to VS Code's dark, light, and high-contrast themes

---

## Requirements

- [Claude Code](https://marketplace.visualstudio.com/items?itemName=Anthropic.claude-code) must be installed and activated
- VS Code **1.85** or later

> The extension declares `Anthropic.claude-code` as a dependency, so VS Code will prompt you to install it if it's missing.

---

## Installation

### From the Marketplace *(coming soon)*

Search for **"Claude Session Switcher"** in the VS Code Extensions panel (`Ctrl+Shift+X` / `Cmd+Shift+X`).

### From a VSIX file

1. Download the latest `.vsix` from the [Releases](https://github.com/eranra/claude-session-switcher/releases) page
2. In VS Code, open the Extensions panel
3. Click the **`···`** menu → **Install from VSIX...**
4. Select the downloaded file

### From source

```bash
git clone https://github.com/eranra/claude-session-switcher.git
cd claude-session-switcher
npm install
npm run compile
```

Then press **`F5`** in VS Code to launch an Extension Development Host with the extension loaded.

---

## Getting Started

1. Open the **Secondary Sidebar** (`Ctrl+Alt+B` / `Cmd+Alt+B`, or **View → Secondary Side Bar**)
2. Click the **Claude Sessions** icon in the Secondary Sidebar's activity bar
3. Your recent Claude Code sessions appear as tabs

| Action | How |
|--------|-----|
| Switch to a session | Click the tab |
| Close a tab | Click `×` on the tab |
| Start a new session | Click the `+` button |

---

## How It Works

Claude Code stores session transcripts locally at:

```
~/.claude/projects/<project-path>/<session-uuid>.jsonl
```

This extension reads those files to extract session titles (the first message you sent) and project names — **without any network requests or Claude Code APIs**. It watches the directory for changes using VS Code's file system watcher, so the tab strip stays in sync automatically.

When you click a tab, it calls:

```
vscode://anthropic.claude-code/open?session=<uuid>
```

This routes through VS Code's URI handler directly to Claude Code, which loads the session in its panel. No reimplementation of Claude Code internals — just a URI call.

---

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for a detailed breakdown of components, the session data format, and the end-to-end message flow.

---

## Known Limitations

- **Session titles are approximate** — Claude Code's AI-generated session titles aren't accessible from outside the extension. Titles here come from the first message you typed, truncated to 60 characters.
- **No active session indicator** — the tab strip cannot tell which session Claude Code currently has open.
- **Switching speed** — session switching goes through VS Code's URI handler (a round-trip through the OS), so it may feel slightly slower than native tab switching (~50–200 ms extra).

---

## Contributing

Issues and pull requests welcome. Please open an issue first to discuss significant changes.

```bash
npm run compile   # TypeScript → out/
npm run lint      # ESLint check
```

---

## License

MIT
