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

The MCP server includes browser navigation, screenshots, DOM snapshots, console/network inspection, form and link checks, Lighthouse, axe, DOM and visual hierarchy, spacing, contrast, tap-target, computed-style, image slicing/annotation, visual diff, and `forma_audit` tools. `browser_open` uses headless Chromium by default. Set `headed: true` to show a separate Playwright Chromium window; it does not attach to a user's existing browser profile. Private/local navigation requires an explicit `allow_private: true` argument from the client. Hosts should ask users before invoking browser tools; the FORMA CLI does so by default, including before clicks, typing, and scrolling.

On first browser use, Chromium is installed automatically when possible. Install it manually with `npx playwright install chromium` if needed.

## Browser tools

| Tool | What it reads or changes |
|---|---|
| `browser_open` | Navigate to a URL, choose desktop/tablet/mobile, opt into a local host, or request a visible browser window with `headed: true`. |
| `page_snapshot`, `dom_hierarchy` | Read visible page content, headings, landmarks, links, controls, and DOM nesting. |
| `console_logs`, `network_failures`, `capture_telemetry` | Inspect console warnings/errors, page crashes, failed/HTTP requests, fonts, performance signals, responsive overflow, and tap target sizes. |
| `browser_click`, `browser_type`, `browser_scroll` | Interact with page controls. These change page state; obtain user approval in the MCP host before calling them. |
| `form_scan`, `link_check`, `axe_scan` | Check form names, link labels/destinations, and accessibility rules. |
| `screenshot`, `lighthouse`, `visual_hierarchy`, `measure_spacing`, `contrast_scan`, `tap_target_scan`, `computed_styles` | Capture and measure the page. |
| `slice_image`, `annotate_image`, `visual_diff`, `forma_audit` | Prepare, compare, annotate, and send screenshots to the configured FORMA auditor. |

Each MCP host controls its own consent UI. FORMA CLI prompts before all MCP tools unless the user has saved an allow/deny rule. `headed: true` opens a separate Chromium process; this server does not access browser cookies, saved passwords, or the user's existing browser profile. Browser operations can access page content and should only be used on sites the user is authorized to inspect.
