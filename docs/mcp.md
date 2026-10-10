# Use the Forma MCP server from other tools

Forma MCP is an ordinary stdio MCP server. It does not require the Forma CLI. The browser, accessibility, visual-diff, image-tiling, and audit tools can be connected from any MCP client or IDE.

## General MCP config

```json
{
  "mcpServers": {
    "forma": {
      "command": "npx",
      "args": ["-y", "@forma-ai/forma-mcp"],
      "env": {
        "FORMA_URL": "https://your-kaggle-tunnel.trycloudflare.com",
        "FORMA_TOKEN": "your-bearer-token"
      }
    }
  }
}
```

Use the client’s secret/environment reference feature instead of committing credentials. A direct install can use `node /absolute/path/to/packages/forma-mcp/dist/src/index.js` as the command.

## IDEs and agent CLIs

Most MCP clients expose equivalent fields for a local command, argument array, and environment variables. Example OpenCode configuration:

```json
{
  "mcp": {
    "forma": {
      "type": "local",
      "command": ["npx", "-y", "@forma-ai/forma-mcp"],
      "environment": {
        "FORMA_URL": "{env:FORMA_URL}",
        "FORMA_TOKEN": "{env:FORMA_TOKEN}"
      },
      "enabled": true
    }
  },
  "permission": { "forma_*": "ask" }
}
```

For Cursor, Claude Code, VS Code, Windsurf, or another MCP host, copy the general config into that client’s MCP settings and rename `mcpServers` if its schema uses a different key. Set per-tool approval in the client. In particular, require approval for browser navigation, `browser_click`, `browser_type`, `browser_scroll`, `forma_audit`, and filesystem-affecting agent tools. Browser interaction tools can change the page. The MCP server writes screenshots and image outputs under the project’s `.forma/artifacts/` directory.

## URL security

`browser_open` defaults to `allow_private=false` and `headed=false`; it blocks loopback, local names, and private address ranges. Set `allow_private=true` only when intentionally testing a development server you control. Set `headed=true` to show a separate Playwright Chromium window; it does not attach to the user's normal browser profile. The server also checks each browser request so an allowed public page cannot silently redirect the browser to a private address.

The server can read DOM snapshots, headings, links, forms, console/network errors, accessibility issues, responsive measurements, and screenshots. `browser_click`, `browser_type`, and `browser_scroll` change page state; the MCP host should request user approval before invoking them. The FORMA CLI prompts for every MCP call unless the user saved a per-tool permission rule.

## Audit prompt contract

The VLM receives a screenshot resized to a maximum side of 512 px and one user text part. The text comes from the dataset's `user_prompt`, followed by the exact measured-context heading and JSON-serialized telemetry. It does not receive source code. Keep the coding model's source context in the coding conversation; do not add it to the FORMA prompt unless the training format changes.
