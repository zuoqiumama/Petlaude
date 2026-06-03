<p align="center">
  <img src="assets/icons/512x512.png" width="128" alt="Petlaude">
</p>
<h1 align="center">Petlaude</h1>
<p align="center">
  <sub>An enhanced fork of <a href="https://github.com/rullerzhou-afk/clawd-on-desk">Clawd on Desk</a> with refined UI, theme support, and usage analytics.</sub>
</p>

> A desktop pet that reacts to your AI coding agent in real time. Start a long task, walk away, come back when the pet tells you it's done.

## What's New in Petlaude

### Task Complete Bubble

When your AI agent finishes a task, a notification bubble pops up with a "Go to" button that focuses the agent's terminal window — no more hunting for the right tab. Works with Claude Code, Codex, Gemini, Copilot, and every supported agent. Smart dedup and cooldown prevent spam during rapid session restarts.

### Pet Double-Click Action

Configure what happens when you double-click the desktop pet — launch Codex, Claude, your editor, or any executable. Choose between Terminal mode (for CLI agents) and Direct mode (for GUI apps), with an optional default workspace folder. The existing pet reaction animation still plays alongside your custom action.

### File Drag-and-Drop

Drag files and folders onto the pet! A directional catch animation plays as you hover, then a smart bubble offers context-aware actions: focus the matching agent session, open the dashboard, launch your configured pet click action, or copy paths to the clipboard.

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
- **Trend line** — smooth monotone cubic interpolation curves overlay session time and token trends on the bar chart
- **Dual-axis labels** — token counts on the left, time duration on the right, with clean grid lines for readability
- **Usage hover** — hover over the desktop pet to see a quick popup with today's agent breakdown via a compact pie/bar chart

<p align="center">
  <img src="img/hover.png" width="320" alt="Usage hover popup">
  <br><sub>Usage hover — today's agent time at a glance</sub>
</p>

Sessions and time are persisted in a local JSONL ledger, so your stats survive restarts.

### Windows Terminal Focus Reliability

The focus system (used by "Go to" buttons and session switching) has been hardened for Windows Terminal with a multi-layered fallback strategy: MainWindowHandle fast path → process ancestor chain walk → any WindowsTerminal process → AppActivate last resort. This dramatically improves the reliability of jumping to the right agent window.

### Permission Bubble Agent Labels

Permission bubbles now show the agent's display name ("Claude Code Permission Request" instead of the generic title), making it clear which agent is asking for access — especially useful when running multiple agents simultaneously.

### Usage Cost Tracking

Every tracked session now includes **cost estimates** powered by a multi-tier model pricing engine. The resolver matches model names against curated overrides, a LiteLLM pricing snapshot (~2,000+ models), and fuzzy fallback rules — covering mainstream providers (Claude, GPT, Gemini) plus niche agents like Kiro, Qwen, and Antigravity. Token usage is priced per million tokens (input, output, cache read, cache write, reasoning) and displayed as USD estimates throughout the dashboard.

Token normalization has been upgraded to the **canonical v2 schema** with full breakdown support: input tokens, cached input, cache creation input, output tokens, reasoning output, and unattributed tokens. The system automatically corrects for agents that report input tokens inclusive of cache reads (Codex, Copilot, EveryCode).

### Automatic Model Detection

Model names are now **resolved from agent transcript files** when the hook payload doesn't include them directly. For Codex, the resolver walks UUID v7 session directories (date-based lookup) and reads the JSONL transcript tail to extract the model. For Claude Code, it scans the transcript JSONL for assistant messages with usage data. Results are cached per session to avoid repeated file I/O.

### Enhanced Dashboard — Period Tabs & Provider Overview

The usage dashboard has been redesigned with **period selectors** (Today / 7 days / 30 days / Total) that re-aggregate all dimensions on the fly:

- **Provider overview** — colored bar chart and cards showing token share, cost, and top models per AI provider
- **Stats panel** — 7-day and 30-day rolling totals, average active day metrics, conversation counts, and top model highlight
- **Cost column** — every agent row now shows estimated USD cost alongside token counts
- **Token type breakdown** — detailed inline display: `input / cache / output / reasoning / unknown`

<p align="center">
  <img src="img/dashboard.png" width="600" alt="Dashboard with usage charts">
  <br><sub>Dashboard — session list with usage analytics charts</sub>
</p>

### Usage Heatmap

A **GitHub-style contribution heatmap** (53 weeks × 7 days) visualizes your coding activity over the past year. Hover any cell to see the day's token count, models used, and provider breakdown. Tracks active day rate, current streak, and peak day — giving you a bird's-eye view of your AI coding habits.

### Multi-Dimensional Aggregation

Usage data is now aggregated across **five dimensions** simultaneously — by agent, source (provider), model, project, and time bucket — all computed from a single event stream. Half-hour UTC buckets power the hourly trend chart; monthly roll-ups feed the long-term trend line; per-project breakdowns let you see which codebases consume the most tokens.

### Context Breakdown & Cost Analysis

The analytics engine exposes structured **context breakdown** (what percentage of tokens went to input vs. cache vs. output vs. reasoning) and **cost analysis** (per-source and per-model cost estimates with priced/unpriced token ratios). These are available to the dashboard and can be consumed programmatically via the snapshot API.

### Codex Hook Shim

Codex hook registration now generates a **shim script** that spawns the real hook as a child process. If the hook script is missing or crashes, the shim fails open (returns a safe "no decision") rather than blocking the agent. This eliminates a class of hangs where Codex would wait indefinitely for a hook that never responded.

### Expanded Agent Compatibility

All agent hooks now recognize **40+ token field name variants** across camelCase, snake_case, and vendor-specific formats — covering edge cases from Copilot's `tokensIn`/`tokensOut` to Gemini's `promptTokenCount`/`candidatesTokenCount`. Provider metadata is forwarded from hook payloads through the state machine to the analytics ledger, enabling accurate per-provider pricing.

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
