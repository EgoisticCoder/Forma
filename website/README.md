# FORMA website

The Next.js landing page for FORMA CLI and the reusable browser MCP package.

## Develop and build

From the repository root:

```sh
npm install
npm run build:website
```

To run the local site:

```sh
npm run dev -w @forma-ai/website
```

Deploy on Vercel with `website` as the root directory. The site has no required environment variables.

## Product capabilities shown here

- FORMA CLI uses the supplied terminal mascot asset and supports saved terminal themes, progress/animation settings, and interactive commands. See [`../packages/forma-cli/README.md`](../packages/forma-cli/README.md).
- The CLI and MCP server inspect pages in Playwright Chromium: DOM snapshots, screenshots, console errors, failed requests, accessibility, responsiveness, and visual measurements.
- `forma audit URL --headed` opens a visible, separate Chromium window. It does not use the visitor's normal browser profile.
- Browser navigation is permissioned by the CLI or MCP host. Click, type, and scroll tools change page state and require user approval in the CLI. Local/private targets require opt-in.
- The visual FORMA model provides screenshot audits; the separately selected coding model handles code changes.

## Source

The page and styles are in `app/`. For repository-wide setup and deployment notes, see [`../README.md`](../README.md).
