# FORMA MCP

Reusable Playwright browser and UI/UX debugging tools for any MCP-compatible coding agent or IDE. It communicates over MCP stdio and saves screenshots and image artifacts under `.forma/artifacts/` in the active project.

## Configure an MCP client

Launch `forma-mcp` with the tunnel endpoint and bearer token in its environment:

```json
{
  "command": "npx",
  "args": ["-y", "@forma-ai/forma-mcp"],
  "env": {
    "FORMA_URL": "https://your-kaggle-tunnel.trycloudflare.com",
    "FORMA_TOKEN": "your-bearer-token"
  }
}
```

The MCP server includes browser navigation, screenshots, telemetry, console/network inspection, Lighthouse, axe, DOM and visual hierarchy, spacing, contrast, tap-target, computed-style, image slicing/annotation, visual diff, and `forma_audit` tools. Private/local navigation requires an explicit `allow_private` argument from the client.

On first browser use, Chromium is installed automatically when possible. Install it manually with `npx playwright install chromium` if needed.
