# FORMA CLI

Standalone terminal coding agent with UI/UX debugging tools powered by a separately hosted FORMA vision model. The coding orchestrator is any OpenAI-compatible tool-calling model, including Groq, OpenAI, and local Ollama endpoints. The CLI uses the supplied FORMA mascot text asset in its terminal banner and ships the matching SVG asset.

## Install

```sh
npm install --global @forma-ai/forma @forma-ai/forma-mcp
forma
```

On first launch, enter the FORMA Kaggle endpoint URL and bearer token, then your coding provider's OpenAI-compatible base URL, key, and model ID. Secrets are stored in `~/.forma/config.json` with owner-only permissions.

```sh
forma config
forma config show
forma audit https://example.com
forma audit https://example.com --headed --lighthouse
forma eval ./screenshots
```

## Interactive commands

Run `forma` inside a project directory. The agent can read and search project files, call the browser MCP tools, search/fetch public web pages, and run approved shell commands. File writes show a diff and require confirmation. Tool permissions can be allowed or denied per tool; choose **always allow** to persist a rule in `~/.forma/permissions.json`.

The browser starts headless by default. Ask the agent to open a page visibly, or use `forma audit URL --headed`, to open a separate Playwright Chromium window. It does not attach to or read your normal browser profile. Page navigation and reads (DOM, console, network, accessibility) require MCP permission; clicks, typing, and scrolling also prompt before they change page state. Local/private URLs require a separate opt-in.

Interactive commands:

| Command | Action |
|---|---|
| `/help` | Show commands and examples |
| `/status` | Show model, workspace, MCP status, and theme |
| `/tools`, `/mcp` | List tools |
| `/theme forma\|ocean\|ember\|mono` | Change the saved terminal theme |
| `/settings animations on\|off`, `/settings progress on\|off` | Change saved terminal behavior |
| `/model [model-id]` | Show or change the coding model |
| `/compact`, `/clear` | Reduce or clear conversation context |
| `/todos`, `/permissions` | Review session tasks and saved permission rules |
| `/exit` | Leave the session |

The mascot ASCII is loaded from `forma-mascot(1).txt`; the companion artwork is `forma-mascot-mono-amber.svg`. Both are included in the published package.

The FORMA vision model only audits screenshots. The configured coding model is the agent and decides when to call tools.
