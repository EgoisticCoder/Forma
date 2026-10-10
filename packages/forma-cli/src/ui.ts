import { stdout } from "node:process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type ThemeName = "forma" | "ocean" | "ember" | "mono";
const palettes: Record<ThemeName, Record<string, string>> = {
  forma: { primary: "35", accent: "36", good: "32", warn: "33", bad: "31", quiet: "2" },
  ocean: { primary: "34", accent: "36", good: "32", warn: "93", bad: "91", quiet: "2" },
  ember: { primary: "31", accent: "33", good: "32", warn: "93", bad: "91", quiet: "2" },
  mono: { primary: "1", accent: "37", good: "37", warn: "37", bad: "1;37", quiet: "2" },
};
let theme: ThemeName = "forma";
let animations = true;
let progressVisible = true;
const useColor = Boolean(stdout.isTTY) && !process.env.NO_COLOR && process.env.TERM !== "dumb";
const ansi = (code: string, value: string) => useColor ? `\u001b[${code}m${value}\u001b[0m` : value;
const paint = (role: string, value: string) => ansi(palettes[theme][role] || "0", value);
const mascot = (() => {
  try {
    const asset = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../forma-mascot(1).txt");
    const text = readFileSync(asset, "utf8");
    return text.split("PLAIN ASCII")[1]?.trim() || "";
  } catch { return ""; }
})();

export const ui = {
  themes: Object.keys(palettes) as ThemeName[],
  configure(options: { theme?: string; animations?: boolean; progress?: boolean }) {
    if (options.theme && options.theme in palettes) theme = options.theme as ThemeName;
    if (typeof options.animations === "boolean") animations = options.animations;
    if (typeof options.progress === "boolean") progressVisible = options.progress;
  },
  theme: () => theme,
  bold: (value: string) => ansi("1", value),
  dim: (value: string) => paint("quiet", value),
  cyan: (value: string) => paint("accent", value),
  green: (value: string) => paint("good", value),
  yellow: (value: string) => paint("warn", value),
  red: (value: string) => paint("bad", value),
  magenta: (value: string) => paint("primary", value),
  prompt: () => `${ansi("1", paint("accent", "you"))} ${paint("quiet", "›")} `,
  rule(label = "") {
    const width = Math.max(36, Math.min(stdout.columns || 80, 96));
    if (!label) return paint("quiet", "─".repeat(width));
    const title = ` ${label} `;
    const left = Math.max(2, Math.floor((width - title.length) / 2));
    return `${paint("quiet", "─".repeat(left))}${ansi("1", paint("primary", title))}${paint("quiet", "─".repeat(Math.max(2, width - left - title.length)))}`;
  },
  banner(version: string, cwd: string) {
    console.log("");
    if (mascot) console.log(mascot.split("\n").map(line => `  ${paint("primary", line)}`).join("\n"));
    console.log(`  ${ansi("1", paint("accent", "FORMA"))}  ${paint("quiet", `visual coding agent · v${version}`)}`);
    console.log(`  ${paint("quiet", cwd)}`);
    console.log(this.rule());
  },
  section(label: string) { console.log(`\n${ansi("1", paint("primary", label))}`); },
  item(name: string, description: string) {
    if (name.length >= 26) { console.log(`  ${ansi("1", paint("accent", name))}\n  ${" ".repeat(26)}${paint("quiet", description)}`); return; }
    console.log(`  ${ansi("1", paint("accent", name.padEnd(26)))}${paint("quiet", description)}`);
  },
  progress(label: string, current: number, total: number) {
    if (!progressVisible) return;
    const ratio = Math.min(1, Math.max(0, current / Math.max(1, total)));
    const width = Math.max(12, Math.min(30, (stdout.columns || 80) - label.length - 20));
    const filled = Math.round(ratio * width);
    const text = `${paint("accent", "█".repeat(filled) + "░".repeat(width - filled))} ${String(Math.round(ratio * 100)).padStart(3)}% ${label} (${current}/${total})`;
    if (stdout.isTTY) stdout.write(`\r\u001b[2K${text}${current >= total ? "\n" : ""}`);
    else console.log(text);
  },
  async spin<T>(label: string, action: () => Promise<T>): Promise<T> {
    if (!stdout.isTTY || !animations) {
      console.log(`${paint("accent", "◆")} ${label}…`);
      try { return await action(); } catch (error) { console.log(`${paint("bad", "✗")} ${label}`); throw error; }
    }
    const frames = ["◒", "◐", "◓", "◑"];
    let frame = 0;
    const timer = setInterval(() => stdout.write(`\r\u001b[2K${paint("accent", frames[frame++ % frames.length])} ${label}`), 90);
    try {
      const result = await action(); clearInterval(timer); stdout.write(`\r\u001b[2K${paint("good", "✓")} ${label}\n`); return result;
    } catch (error) { clearInterval(timer); stdout.write(`\r\u001b[2K${paint("bad", "✗")} ${label}\n`); throw error; }
  },
};

export const toolLabel = (name: string) => name.replace(/^forma_mcp_/, "").replaceAll("_", " ");
export function briefArgs(args: Record<string, unknown>) {
  return Object.entries(args).slice(0, 2).map(([key, value]) => `${key}: ${String(typeof value === "string" ? value : JSON.stringify(value)).slice(0, 72)}`).join(" · ");
}
