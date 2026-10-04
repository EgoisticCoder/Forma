import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import dns from "node:dns/promises";
import { isIP } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

type CodingConfig = { provider: string; baseUrl: string; apiKey: string; model: string };
type AgentConfig = { formaUrl: string; formaToken: string; coding: CodingConfig };
type ToolSpec = { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } };
type Message = { role: string; [key: string]: any };

const permissionsPath = path.join(os.homedir(), ".forma", "permissions.json");
const blockedDirs = new Set([".git", "node_modules", ".next", "dist", "build", ".forma"]);
const secretPath = /(^|[/\\])(?:\.env(?:\.[^/\\]*)?|secrets?)(?:$|[/\\])/i;
const str = { type: "string" };
const optionalStr = { type: "string" };
const tools: ToolSpec[] = [
  tool("read_file", "Read a UTF-8 project file. .env and secret files are blocked.", { path: str }),
  tool("write_file", "Create or replace a project file after showing a diff and receiving approval.", { path: str, content: str }),
  tool("edit_file", "Replace one exact text block in a file after showing a diff and receiving approval.", { path: str, old_text: str, new_text: str }),
  tool("list_directory", "List files and directories at a project path.", { path: optionalStr }),
  tool("glob", "Find project files by glob pattern, excluding dependency and build folders.", { pattern: str }),
  tool("grep", "Search project text files for a literal or regular expression.", { pattern: str, path: optionalStr }),
  tool("run_shell", "Run a shell command in the project after explicit approval.", { command: str }),
  tool("web_search", "Search the public web via DuckDuckGo HTML results.", { query: str }),
  tool("web_fetch", "Fetch and extract readable text from a public HTTP(S) URL.", { url: str }),
  tool("todo", "Create or update the agent's task list.", { items: { type: "array", items: { type: "object", properties: { task: { type: "string" }, status: { type: "string", enum: ["todo", "doing", "done"] } }, required: ["task", "status"] } } }),
  tool("ask_user", "Ask the user a direct question and wait for their answer.", { question: str }),
];

function tool(name: string, description: string, properties: Record<string, unknown>): ToolSpec {
  const required = Object.keys(properties).filter((key) => key !== "path" || properties[key] !== optionalStr);
  return { type: "function", function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } } };
}

function safeRelative(inputPath: string, cwd: string) {
  const absolute = path.resolve(cwd, inputPath || ".");
  const rel = path.relative(cwd, absolute);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("Path is outside the project directory.");
  if (secretPath.test(rel)) throw new Error("Access to .env and secret paths is blocked.");
  return { absolute, rel: rel || "." };
}

async function walk(root: string, max = 3000): Promise<string[]> {
  const out: string[] = [];
  async function visit(dir: string) {
    if (out.length >= max) return;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".github") continue;
      if (entry.isDirectory() && blockedDirs.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) out.push(path.relative(root, full));
      if (out.length >= max) return;
    }
  }
  await visit(root);
  return out;
}

function globRegex(pattern: string) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\u0000/g, ".*");
  return new RegExp(`^${escaped}$`);
}

async function askPermission(name: string, detail: string, session: Map<string, "allow" | "deny">, saved: Record<string, string>, rl: ReturnType<typeof createInterface>) {
  const policy = session.get(name) || saved[name] || (name.startsWith("forma_mcp_") ? "ask" : ["write_file", "edit_file", "run_shell"].includes(name) ? "ask" : "allow");
  if (policy === "allow") return true;
  if (policy === "deny") return false;
  console.log(`\nPermission request: ${name}\n${detail}`);
  const answer = (await rl.question("[a]llow once / [A] always allow / [d]eny / [D] always deny: ")).trim();
  if (answer === "A") {
    saved[name] = "allow";
    await fs.mkdir(path.dirname(permissionsPath), { recursive: true, mode: 0o700 });
    await fs.writeFile(permissionsPath, JSON.stringify(saved, null, 2), { mode: 0o600 });
    return true;
  }
  if (answer === "D") {
    saved[name] = "deny";
    await fs.mkdir(path.dirname(permissionsPath), { recursive: true, mode: 0o700 });
    await fs.writeFile(permissionsPath, JSON.stringify(saved, null, 2), { mode: 0o600 });
    return false;
  }
  return answer.toLowerCase() === "a";
}

function previewDiff(before: string, after: string) {
  const a = before.split("\n"), b = after.split("\n");
  const commonPrefix = (() => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; })();
  const commonSuffix = (() => { let i = 0; while (i < a.length - commonPrefix && i < b.length - commonPrefix && a[a.length - 1 - i] === b[b.length - 1 - i]) i++; return i; })();
  return [
    ...a.slice(Math.max(0, commonPrefix - 2), a.length - commonSuffix).map((line) => `- ${line}`),
    ...b.slice(Math.max(0, commonPrefix - 2), b.length - commonSuffix).map((line) => `+ ${line}`),
  ].slice(0, 80).join("\n") || "(no textual changes)";
}

async function shell(command: string, cwd: string) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let out = "", err = "";
    child.stdout.on("data", (chunk) => out += chunk.toString());
    child.stderr.on("data", (chunk) => err += chunk.toString());
    const timer = setTimeout(() => child.kill("SIGTERM"), 120_000);
    child.on("error", reject);
    child.on("close", (code) => { clearTimeout(timer); resolve(JSON.stringify({ exit_code: code, stdout: out.slice(-12000), stderr: err.slice(-6000) })); });
  });
}

function isPrivateAddress(address: string) {
  const value = address.toLowerCase().split("%")[0];
  if (value === "::" || value === "::1" || value.startsWith("fc") || value.startsWith("fd") || /^fe[89ab]/.test(value)) return true;
  if (value.startsWith("::ffff:")) return isPrivateAddress(value.slice(7));
  if (isIP(value) !== 4) return false;
  const octets = value.split(".").map(Number);
  return octets[0] === 0 || octets[0] === 10 || octets[0] === 127 ||
    (octets[0] === 169 && octets[1] === 254) ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168) ||
    (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) || octets[0] >= 224;
}

async function validatePublicUrl(raw: string) {
  const url = new URL(raw);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error("Only public HTTP(S) URLs are allowed.");
  const addresses = isIP(url.hostname) ? [{ address: url.hostname }] : await dns.lookup(url.hostname, { all: true }).catch(() => [] as Array<{ address: string }>);
  if (!addresses.length || url.hostname === "localhost" || url.hostname.endsWith(".localhost") || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error("Web fetch is restricted to public hosts; local/private addresses are blocked.");
  }
  return url;
}

async function runBuiltIn(name: string, args: any, cwd: string, rl: ReturnType<typeof createInterface>, session: Map<string, "allow" | "deny">, saved: Record<string, string>, todos: Array<{ task: string; status: string }>) {
  const needsPermission = ["write_file", "edit_file", "run_shell"].includes(name);
  if (needsPermission && !await askPermission(name, JSON.stringify(args, null, 2), session, saved, rl)) return { error: "User denied this action." };
  if (name === "read_file") {
    const { absolute } = safeRelative(args.path, cwd);
    return { path: args.path, content: (await fs.readFile(absolute, "utf8")).slice(0, 40000) };
  }
  if (name === "list_directory") {
    const { absolute, rel } = safeRelative(args.path || ".", cwd);
    return { path: rel, entries: (await fs.readdir(absolute, { withFileTypes: true })).filter((e) => !e.name.startsWith(".") || e.name === ".github").map((e) => ({ name: e.name, type: e.isDirectory() ? "directory" : "file" })).slice(0, 500) };
  }
  if (name === "glob") {
    if (secretPath.test(args.pattern)) throw new Error("Searching secret paths is blocked.");
    const re = globRegex(args.pattern);
    return { matches: (await walk(cwd)).filter((file) => re.test(file)).slice(0, 300) };
  }
  if (name === "grep") {
    if (secretPath.test(args.path || "")) throw new Error("Searching secret paths is blocked.");
    const base = args.path ? safeRelative(args.path, cwd).absolute : cwd;
    const files = (await walk(base, 1200)).slice(0, 1200);
    let re: RegExp;
    try { re = new RegExp(args.pattern, "i"); } catch { re = new RegExp(args.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"); }
    const matches: Array<{ path: string; line: number; text: string }> = [];
    for (const file of files) {
      if (secretPath.test(file)) continue;
      try {
        const lines = (await fs.readFile(path.join(base, file), "utf8")).split(/\r?\n/);
        lines.forEach((line, i) => { if (matches.length < 200 && re.test(line)) matches.push({ path: path.relative(cwd, path.join(base, file)), line: i + 1, text: line.slice(0, 400) }); re.lastIndex = 0; });
      } catch { /* skip binary/unreadable files */ }
      if (matches.length >= 200) break;
    }
    return { matches };
  }
  if (name === "write_file" || name === "edit_file") {
    const { absolute, rel } = safeRelative(args.path, cwd);
    let before = "";
    try { before = await fs.readFile(absolute, "utf8"); } catch (e: any) { if (e.code !== "ENOENT" || name === "edit_file") throw e; }
    let after: string;
    if (name === "write_file") after = args.content;
    else {
      if (!args.old_text) throw new Error("old_text cannot be empty.");
      const first = before.indexOf(args.old_text);
      if (first < 0) throw new Error("old_text was not found; reread the file and retry.");
      if (before.indexOf(args.old_text, first + args.old_text.length) >= 0) throw new Error("old_text matches more than once; provide a unique block.");
      after = before.slice(0, first) + args.new_text + before.slice(first + args.old_text.length);
    }
    console.log(`\nProposed change: ${rel}\n${previewDiff(before, after)}`);
    const confirm = (await rl.question("Apply this file change? [y/N] ")).trim().toLowerCase();
    if (confirm !== "y" && confirm !== "yes") return { error: "User declined the file change." };
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, after, "utf8");
    return { path: rel, written: true };
  }
  if (name === "run_shell") {
    if (/(^|\s)(cat|less|more|head|tail|source|\.)\s+[^\n]*\.env|\b(printenv|env)\b/i.test(args.command)) throw new Error("Commands that read environment files or dump environment variables are blocked.");
    return await shell(args.command, cwd);
  }
  if (name === "web_search") {
    const response = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(args.query)}`, { headers: { "User-Agent": "Mozilla/5.0 FORMA-CLI" }, signal: AbortSignal.timeout(20000) });
    const html = await response.text();
    const results = [...html.matchAll(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)].slice(0, 8).map((m) => ({ url: m[1].replace(/&amp;/g, "&"), title: m[2].replace(/<[^>]+>/g, "").trim(), snippet: m[3].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").trim() }));
    return { results };
  }
  if (name === "web_fetch") {
    const url = await validatePublicUrl(args.url);
    const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 FORMA-CLI" }, signal: AbortSignal.timeout(20000), redirect: "error" });
    const html = (await response.text()).slice(0, 1_000_000);
    return { url: url.href, status: response.status, text: html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").slice(0, 16000) };
  }
  if (name === "todo") { todos.splice(0, todos.length, ...args.items); return { items: todos }; }
  if (name === "ask_user") return { answer: await rl.question(`\n${args.question}\n> `) };
  throw new Error(`Unknown built-in tool: ${name}`);
}

function systemPrompt(cwd: string) {
  return `You are FORMA, an interactive coding agent working in ${cwd}. Make focused, useful changes. Inspect before editing, explain decisions briefly, and never claim a command succeeded unless its output confirms it. Use tools for repository work. Ask the user when requirements are unclear. FORMA's visual model is only a UI/UX audit tool: use browser MCP tools to open pages, capture telemetry and screenshots, then call forma_audit; do not treat the FORMA VLM as a coding orchestrator. Never expose secrets or read .env/secret files. Every write/edit and shell command requires user permission and a diff preview before file changes.`;
}

export async function runAgent(config: AgentConfig, cwd: string) {
  const rl = createInterface({ input, output });
  const sessionPermissions = new Map<string, "allow" | "deny">();
  let savedPermissions: Record<string, string> = {};
  try { savedPermissions = JSON.parse(await fs.readFile(permissionsPath, "utf8")); } catch { }
  const todos: Array<{ task: string; status: string }> = [];
  const messages: Message[] = [{ role: "system", content: systemPrompt(cwd) }];
  const require = createRequire(import.meta.url);
  const serverPath = require.resolve("@forma-ai/forma-mcp/dist/src/index.js");
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath], env: { ...process.env, FORMA_PROJECT_ROOT: cwd, FORMA_URL: config.formaUrl, FORMA_TOKEN: config.formaToken } as Record<string, string> });
  const mcp = new Client({ name: "forma-agent", version: "0.2.0" });
  let mcpTools: ToolSpec[] = [];
  try {
    await mcp.connect(transport);
    const listed = await mcp.listTools();
    mcpTools = listed.tools.map((entry: any) => ({ type: "function", function: { name: `forma_mcp_${entry.name}`, description: entry.description || entry.name, parameters: entry.inputSchema || { type: "object", properties: {} } } }));
  } catch (error) {
    console.error(`FORMA browser MCP failed to start: ${String(error)}`);
  }
  const availableTools = [...tools, ...mcpTools];
  const endpoint = `${config.coding.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const maxTokens = config.coding.provider === "groq" && config.coding.model === "qwen/qwen3.8-27b" ? 8192 : 4096;
  console.log(`FORMA agent · ${config.coding.model} · ${cwd}`);
  console.log(`${mcpTools.length} browser MCP tools connected. Type /help for commands, /exit to quit.\n`);

  try {
    while (true) {
      const inputText = (await rl.question("you › ")).trim();
      if (!inputText) continue;
      if (["/exit", "/quit"].includes(inputText)) break;
      if (inputText === "/clear") { messages.splice(1); console.log("Conversation cleared.\n"); continue; }
      if (inputText === "/help") { console.log("Commands: /help /clear /permissions /exit\nTools include file search/edit, shell, web search/fetch, todos, and the FORMA browser MCP suite.\n"); continue; }
      if (inputText === "/permissions") { console.log(JSON.stringify(savedPermissions, null, 2) || "No saved rules."); continue; }
      messages.push({ role: "user", content: inputText });

      for (let turn = 0; turn < 12; turn++) {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { Authorization: `Bearer ${config.coding.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: config.coding.model, messages, tools: availableTools, tool_choice: "auto", parallel_tool_calls: false, max_tokens: maxTokens, temperature: 0.2 }),
          signal: AbortSignal.timeout(180000),
        });
        const payload: any = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(`Coding provider returned HTTP ${response.status}: ${payload.error?.message || JSON.stringify(payload).slice(0, 800)}`);
        const choice = payload.choices?.[0];
        if (!choice?.message) throw new Error("Coding provider returned no assistant message.");
        const assistant = choice.message;
        messages.push({ role: "assistant", ...assistant });
        if (assistant.content) console.log(`\n${assistant.content}\n`);
        const calls = assistant.tool_calls || [];
        if (!calls.length) break;
        for (const call of calls) {
          const name = call.function?.name || "";
          let args: any;
          try { args = JSON.parse(call.function?.arguments || "{}"); } catch { args = {}; }
          console.log(`\nTool: ${name} ${JSON.stringify(args)}`);
          let result: unknown;
          try {
            if (name.startsWith("forma_mcp_")) {
              const original = name.slice("forma_mcp_".length);
              if (!await askPermission(name, JSON.stringify(args), sessionPermissions, savedPermissions, rl)) result = { error: "User denied this tool call." };
              else {
                const response: any = await mcp.callTool({ name: original, arguments: args });
                const text = response.content?.find((item: any) => item.type === "text")?.text || "{}";
                result = JSON.parse(text);
              }
            } else result = await runBuiltIn(name, args, cwd, rl, sessionPermissions, savedPermissions, todos);
          } catch (error) { result = { error: error instanceof Error ? error.message : String(error) }; }
          messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result).slice(0, 20000) });
        }
        if (turn === 11) console.log("Reached the tool-call limit for this response; send a follow-up to continue.");
      }
      if (messages.length > 60) messages.splice(1, messages.length - 50);
    }
  } finally {
    await mcp.close().catch(() => {});
    rl.close();
  }
}
