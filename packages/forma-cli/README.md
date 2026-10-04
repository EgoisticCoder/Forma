# FORMA CLI

Standalone terminal coding agent with UI/UX debugging tools powered by a separately hosted FORMA vision model. The coding orchestrator is any OpenAI-compatible tool-calling model, including Groq, OpenAI, and local Ollama endpoints.

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
forma eval ./screenshots
```

## Interactive commands

Run `forma` inside a project directory. The agent can read and search project files, call the browser MCP tools, search/fetch public web pages, and run approved shell commands. File writes show a diff and require confirmation. Tool permissions can be allowed or denied per tool; choose **always allow** to persist a rule in `~/.forma/permissions.json`.

Type `/help`, `/clear`, `/permissions`, or `/exit` in the session.

The FORMA vision model only audits screenshots. The configured coding model is the agent and decides when to call tools.
