<p align="center">
  <img src="assets/tray-icon.png" width="128" alt="Petlaude">
</p>
<h1 align="center">Petlaude</h1>
<p align="center">
  <sub>An enhanced fork of <a href="https://github.com/rullerzhou-afk/clawd-on-desk">Clawd on Desk</a> with refined UI, theme support, and usage analytics.</sub>
</p>

> A desktop pet that reacts to your AI coding agent in real time. Start a long task, walk away, come back when the pet tells you it's done.

## What's New in Petlaude

### Borderless Mac-style Windows

Dashboard and Settings windows have been redesigned with a modern borderless look — rounded corners, smooth title bars, and content that blends naturally into the window frame. Traffic-light window controls (close / minimize / maximize) replace clunky native title bars.

<p align="center">
  <img src="img/dashboard.png" width="600" alt="Dashboard with usage charts">
  <br><sub>Dashboard — session list with usage analytics charts</sub>
</p>

<p align="center">
  <img src="img/settings.png" width="600" alt="Settings window">
  <br><sub>Settings — borderless window with theme switcher</sub>
</p>

### Light / Dark / System Theme

A new appearance mode lets you switch between light, dark, and system-following themes independently from your OS settings. Card backgrounds, text, and borders adapt seamlessly — light mode cards pop with soft shadows, dark mode cards blend into a deep background.

### Vibe Coding Analytics

Track your AI coding sessions with time and token statistics directly in the dashboard:

- **Usage bar chart** — daily agent usage broken down by agent (Claude Code, Codex, Gemini, Copilot, etc.), showing how much time you spend with each
- **Trend line** — overlays a cumulative trend line on the bar chart so you can spot usage patterns over the week
- **Usage hover** — hover over the desktop pet to see a quick popup with today's agent breakdown via a compact pie/bar chart

<p align="center">
  <img src="img/hover.png" width="320" alt="Usage hover popup">
  <br><sub>Usage hover — today's agent time at a glance</sub>
</p>

Sessions and time are persisted in a local JSONL ledger, so your stats survive restarts.

---

## Pet Features

The desktop pet reacts to what your AI coding agent is doing in real time:

- **12 animated states** — idle, thinking, typing, building, subagent groove, multi-subagent juggling, error, happy, notification, sweeping, carrying, sleeping
- **Eye tracking** — the pet follows your cursor in idle state
- **Sleep sequence** — yawns, dozes, collapses after 60s of inactivity
- **Drag anywhere** — grab the pet from any state and move it around
- **Mini mode** — drag to screen edge to auto-hide; peek on hover
- **Click reactions** — double-click to poke, 4 clicks to flail
- **Three built-in themes** — Clawd (pixel crab), Calico (calico cat), Cloudling

### Multi-Agent Support

Works with **Claude Code**, **Codex CLI**, **Copilot CLI**, **Gemini CLI**, **Antigravity CLI**, **Cursor Agent**, **CodeBuddy**, **Kiro CLI**, **Kimi Code CLI**, **Qwen Code**, **opencode**, **Pi**, **OpenClaw**, and **Hermes Agent**. Run multiple agents simultaneously — the pet tracks each session independently.

### Permission Bubbles

When an agent requests tool permissions, the pet pops a floating bubble card so you can Allow / Deny without switching to the terminal. Supports global hotkeys (`Ctrl+Shift+Y` to Allow, `Ctrl+Shift+N` to Deny).

### Session Dashboard & HUD

Right-click → Open Dashboard to inspect live sessions, event history, and jump to a terminal. A compact HUD near the pet keeps current sessions visible at a glance.

### System

- **Click-through** — transparent areas pass clicks to windows below
- **Position memory** — remembers where you left it across restarts
- **Do Not Disturb** — right-click to suppress all notifications
- **System tray** — resize, DND, language switch, auto-start, check for updates
- **i18n** — English, Simplified Chinese, Traditional Chinese, Korean, Japanese

---

## Quick Start

Download the latest installer from **[Releases](https://github.com/zuoqiumama/Petlaude/releases)**.

Or run from source:

```bash
git clone https://github.com/zuoqiumama/Petlaude.git
cd Petlaude
npm install
npm start
```

Agent hooks are auto-registered on first launch. For detailed setup per agent, see the original [setup guide](docs/guides/setup-guide.md).

---

## Credits

**Petlaude** is maintained by **[@zuoqiumama](https://github.com/zuoqiumama)**, with UI redesign, theme system enhancements, and usage analytics.

Built on top of **[Clawd on Desk](https://github.com/rullerzhou-afk/clawd-on-desk)** by 鹿鹿 ([@rullerzhou-afk](https://github.com/rullerzhou-afk)) and [50+ contributors](https://github.com/rullerzhou-afk/clawd-on-desk#contributors). Thank you to everyone who built and improved the original project.

## License

Source code is licensed under [AGPL-3.0](LICENSE). Artwork and theme assets are NOT covered by AGPL-3.0 — all rights reserved by their respective copyright holders.

- Clawd character is the property of [Anthropic](https://www.anthropic.com). Unofficial fan project.
- Calico & Cloudling artwork by 鹿鹿 ([@rullerzhou-afk](https://github.com/rullerzhou-afk)). All rights reserved.
