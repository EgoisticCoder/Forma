#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { chromium, type Browser, type Page } from "playwright";
import sharp from "sharp";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import dns from "node:dns/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { formatTrainingPrompt } from "./prompt.js";

const projectRoot = process.env.FORMA_PROJECT_ROOT || process.cwd();
const artifacts = path.resolve(projectRoot, ".forma/artifacts");
const server = new McpServer({ name: "forma-mcp", version: "0.1.0" });
let browser: Browser | undefined;
let page: Page | undefined;
let captured: { console: Array<Record<string, string>>; failed: Array<Record<string, string>>; http: Array<Record<string, unknown>>; crashes: string[] } = { console: [], failed: [], http: [], crashes: [] };
const viewportPresets: Record<string, { width: number; height: number }> = {
  desktop: { width: 1920, height: 1080 }, tablet: { width: 768, height: 1024 }, mobile: { width: 390, height: 854 },
};
const addTool = (name: string, description: string, schema: Record<string, z.ZodTypeAny>, fn: (args: any) => Promise<unknown>) =>
  server.tool(name, description, schema, async (args) => {
    try { return { content: [{ type: "text", text: JSON.stringify(await fn(args), null, 2) }] }; }
    catch (error) { return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) }] }; }
  });
function safeTelemetryText(value: string) {
  return value.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@").replace(/([?&](?:token|key|api_key|apikey|secret|password|auth)=)[^&#\s]+/gi, "$1[redacted]").replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|Bearer\s+\S+)/gi, "[redacted]").slice(0, 300);
}

async function ensurePage() {
  if (!browser) {
    try { browser = await chromium.launch({ headless: true }); }
    catch (firstError) {
      if (!/executable|browserType.launch/i.test(String(firstError))) throw firstError;
      try { await runCommand("npx", ["playwright", "install", "chromium"], projectRoot, 180000); browser = await chromium.launch({ headless: true }); }
      catch (installError) { throw new Error(`Chromium is not installed and automatic setup failed. Run 'npx playwright install chromium'. ${String(installError).slice(0, 300)}`); }
    }
  }
  if (!page || page.isClosed()) {
    const context = await browser.newContext({ viewport: viewportPresets.desktop, deviceScaleFactor: 1 });
    context.route("**/*", async route => {
      const allowed = Boolean((context as any).__formaAllowPrivate);
      try { await validateUrl(route.request().url(), allowed); await route.continue(); }
      catch { await route.abort("blockedbyclient"); }
    });
    page = await context.newPage();
    await page.addInitScript(`(() => {
      window.__uxPerf = { lcp: 0, cls: 0, long_tasks: 0 };
      try { new PerformanceObserver(list => { for (const e of list.getEntries()) window.__uxPerf.lcp = e.startTime; }).observe({type: 'largest-contentful-paint', buffered: true}); } catch (_) {}
      try { new PerformanceObserver(list => { for (const e of list.getEntries()) if (!e.hadRecentInput) window.__uxPerf.cls += e.value; }).observe({type: 'layout-shift', buffered: true}); } catch (_) {}
      try { new PerformanceObserver(list => { window.__uxPerf.long_tasks += list.getEntries().length; }).observe({type: 'longtask', buffered: true}); } catch (_) {}
    })();`);
    page.on("console", msg => { if (["error", "warning"].includes(msg.type())) captured.console.push({ type: msg.type(), text: safeTelemetryText(msg.text()) }); });
    page.on("pageerror", err => captured.crashes.push(safeTelemetryText(err.message)));
    page.on("requestfailed", req => captured.failed.push({ url: safeTelemetryText(req.url()), method: req.method(), resource_type: req.resourceType(), failure: safeTelemetryText(req.failure()?.errorText || "unknown").slice(0, 200) }));
    page.on("response", res => { if (res.status() >= 400) captured.http.push({ url: safeTelemetryText(res.url()), status: res.status(), resource_type: res.request().resourceType() }); });
  }
  return page;
}
async function saveShot(p: Page, name: string, fullPage = false, selector?: string) {
  await fs.mkdir(artifacts, { recursive: true });
  const target = path.join(artifacts, `${Date.now()}-${name}.png`);
  const locator = selector ? p.locator(selector).first() : undefined;
  await (locator || p).screenshot({ path: target, fullPage: !selector && fullPage, animations: "disabled" });
  const info = await sharp(target).metadata();
  return { path: target, width: info.width, height: info.height };
}
const privateIPv4 = (ip: string) => /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(ip);
function privateIPv6(ip: string) { const v = ip.toLowerCase(); return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || /^fe[89ab]/.test(v) || v.startsWith("::ffff:127.") || v.startsWith("::ffff:10.") || v.startsWith("::ffff:192.168."); }
async function validateUrl(raw: string, allowPrivate: boolean) {
  const u = new URL(raw);
  if (!/^https?:$/.test(u.protocol)) throw new Error("Only http(s) URLs are supported.");
  if (u.username || u.password) throw new Error("URLs containing credentials are rejected.");
  if (!allowPrivate) {
    const addresses = await dns.lookup(u.hostname, { all: true }).catch(() => [] as Array<{ address: string }>);
    if (u.hostname === "localhost" || u.hostname.endsWith(".localhost") || addresses.some(({ address }) => address.includes(":") ? privateIPv6(address) : privateIPv4(address)))
      throw new Error("This host resolves to a local/private network. Retry with allow_private=true only for a dev server you control.");
  }
  return u.href;
}
async function imageBase64(imagePath: string) {
  const buf = await sharp(path.resolve(projectRoot, imagePath)).rotate().resize({ width: 512, height: 512, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer();
  return `data:image/jpeg;base64,${buf.toString("base64")}`;
}
async function endpointCredentials() {
  const configPath=process.env.FORMA_CONFIG_PATH;
  if(configPath){try{const config=JSON.parse(await fs.readFile(configPath,"utf8"));if(config.formaUrl&&config.formaToken)return{base:String(config.formaUrl).replace(/\/$/,""),token:String(config.formaToken)};}catch{}}
  return{base:(process.env.FORMA_URL||"").replace(/\/$/,""),token:process.env.FORMA_TOKEN||""};
}
async function runCommand(command: string, args: string[], cwd: string, timeoutMs = 90000, env: NodeJS.ProcessEnv = process.env) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] }); let out = ""; let err = "";
    child.stdout.on("data", d => out += d.toString()); child.stderr.on("data", d => err += d.toString());
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.on("error", reject); child.on("close", code => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(`${command} exited ${code}: ${err.slice(-1200)}`)); });
  });
}
const telemetryEvaluate = async (p: Page) => p.evaluate(() => {
  const px = (el: Element) => parseFloat(getComputedStyle(el).fontSize) || 0;
  const buttons = [...document.querySelectorAll("button, a, [role='button']")];
  const tap = buttons.slice(0, 15).map(b => { const r = b.getBoundingClientRect(); return { text: ((b as HTMLElement).innerText || b.getAttribute("aria-label") || "").trim().slice(0, 25), w: Math.round(r.width), h: Math.round(r.height) }; });
  const body = document.body ? getComputedStyle(document.body) : null;
  const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  const paints = Object.fromEntries(performance.getEntriesByType("paint").map(e => [e.name, Math.round(e.startTime)]));
  const resources = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
  const perf = (window as any).__uxPerf || {};
  return {
    measured: {
      body_font: body ? body.fontFamily.split(",")[0].replace(/[\'"]/g, "") : "unknown", body_size: document.body ? px(document.body) : 0,
      overflow_x: document.documentElement.scrollWidth > window.innerWidth, tap_targets: tap,
      images_missing_alt: [...document.images].filter(i => !i.alt).length, total_images: document.images.length,
      lighthouse_signals: { fcp_ms: (paints as any)["first-contentful-paint"] ?? null, lcp_ms: Math.round(perf.lcp || 0), cls: Number((perf.cls || 0).toFixed(3)), long_task_count: perf.long_tasks || 0, dom_content_loaded_ms: nav ? Math.round(nav.domContentLoadedEventEnd) : null, load_ms: nav?.loadEventEnd ? Math.round(nav.loadEventEnd) : null, transfer_bytes: resources.reduce((n, r) => n + (r.transferSize || 0), 0), resource_count: resources.length }
    },
    fonts: document.fonts ? [...new Set([...document.fonts].map(f => f.family.replace(/[\'"]/g, "")))] : []
  };
});
async function captureTelemetry(p: Page) {
  const original = p.viewportSize() || viewportPresets.desktop;
  const { measured, fonts } = await telemetryEvaluate(p);
  const responsive_overflow: Record<string, unknown> = {};
  try {
    for (const width of [1920, 768, 390]) {
      await p.setViewportSize({ width, height: 800 }); await p.waitForTimeout(200);
      responsive_overflow[`overflow_x_${width}`] = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      responsive_overflow[`width_details_${width}`] = await p.evaluate(() => ({ viewport_width: window.innerWidth, document_width: document.documentElement.scrollWidth, overflow_px: Math.max(0, document.documentElement.scrollWidth - window.innerWidth) }));
    }
  } finally { await p.setViewportSize(original); }
  let axe: unknown;
  try { await p.addScriptTag({ path: fileURLToPath(import.meta.resolve("axe-core/axe.min.js")) }); axe = await p.evaluate(async () => { const a = await (window as any).axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"] } }); return { status: "complete", passes: a.passes.length, incomplete: a.incomplete.length, violations: a.violations.map((v: any) => ({ id: v.id, impact: v.impact, help: v.help, help_url: v.helpUrl, tags: v.tags, affected_nodes: v.nodes.length, nodes: v.nodes.slice(0, 12).map((n: any) => ({ target: n.target, summary: n.failureSummary, html: n.html.slice(0, 240) })) })) }; }); }
  catch (error) { axe = { status: "error", reason: String(error).slice(0, 300) }; }
  return { console_errors: captured.console, page_crashes: captured.crashes, network_failures: captured.failed.slice(0, 100), http_errors: captured.http.slice(0, 100), measured, fonts, responsive_overflow, axe };
}
const auditSchema = z.object({ issues: z.array(z.object({ category: z.string(), severity: z.string(), element: z.string(), evidence: z.string(), detail: z.string(), suggestion: z.string() })), scores: z.object({ accessibility: z.number(), typography: z.number(), hierarchy: z.number(), color: z.number(), spacing: z.number(), element_sizing: z.number() }), summary: z.string(), page_type: z.string() });

addTool("browser_open", "Navigate the persistent browser to a public or explicitly opted-in local URL and set a standard viewport.", { url: z.string(), viewport: z.enum(["desktop", "tablet", "mobile"]).default("desktop"), allow_private: z.boolean().default(false) }, async ({ url, viewport, allow_private }) => {
  const safeUrl = await validateUrl(url, allow_private); const p = await ensurePage(); captured = { console: [], failed: [], http: [], crashes: [] };
  (p.context() as any).__formaAllowPrivate = allow_private;
  await p.setViewportSize(viewportPresets[viewport]); await p.goto(safeUrl, { waitUntil: "domcontentloaded", timeout: 30000 }); await p.waitForTimeout(1200);
  return { url: p.url(), title: await p.title(), viewport: viewportPresets[viewport], screenshot: await saveShot(p, "browser-open") };
});
addTool("screenshot", "Capture the current page or a selected element under .forma/artifacts.", { viewport: z.enum(["desktop", "tablet", "mobile"]).optional(), full_page: z.boolean().default(false), selector: z.string().optional() }, async ({ viewport, full_page, selector }) => {
  const p = await ensurePage(); if (viewport) await p.setViewportSize(viewportPresets[viewport]);
  if (selector && !(await p.locator(selector).count())) throw new Error(`No element matched ${selector}`);
  return { url: p.url(), ...(await saveShot(p, "screenshot", full_page, selector)) };
});
addTool("capture_telemetry", "Collect console, crash, network, font, responsive overflow, tap-target, image-alt and performance measurements in the scrap.py schema.", {}, async () => captureTelemetry(await ensurePage()));
addTool("console_logs", "Return console errors and warnings collected since the last browser_open.", {}, async () => ({ entries: captured.console }));
addTool("network_failures", "Return failed requests and HTTP error responses collected since browser_open.", {}, async () => ({ failures: captured.failed, http_errors: captured.http }));
addTool("lighthouse", "Run Lighthouse CLI and return category scores and top failing audits; requires Chrome and npx Lighthouse.", { url: z.string().optional(), categories: z.array(z.enum(["performance", "accessibility", "best-practices", "seo"])).default(["performance", "accessibility", "best-practices", "seo"]), allow_private: z.boolean().default(false) }, async ({ url, categories, allow_private }) => {
  await ensurePage();
  const target = url ? await validateUrl(url, allow_private) : (await ensurePage()).url();
  const json = await runCommand("npx", ["--yes", "lighthouse", target, "--output=json", "--quiet", "--chrome-flags=--headless"], projectRoot, 180000, {...process.env,CHROME_PATH:chromium.executablePath()});
  const report = JSON.parse(json); return { url: target, scores: Object.fromEntries(categories.map((c:string) => [c, report.categories?.[c]?.score == null ? null : Math.round(report.categories[c].score * 100)])), top_failing_audits: Object.values(report.audits || {}).filter((a: any) => a.score !== null && Number(a.score) < 0.9 && (a.details?.type !== "opportunity" || a.details?.overallSavingsMs > 0)).sort((a: any, b: any) => (a.score ?? 1) - (b.score ?? 1)).slice(0, 12).map((a: any) => ({ id: a.id, title: a.title, score: a.score, display_value: a.displayValue })) };
});
addTool("axe_scan", "Run axe-core WCAG checks and group violations by impact.", {}, async () => {
  const p = await ensurePage(); await p.addScriptTag({ path: fileURLToPath(import.meta.resolve("axe-core/axe.min.js")) });
  const result = await p.evaluate(async () => { const r = await (window as any).axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"] } }); return { passes: r.passes.length, violations: r.violations.map((v: any) => ({ id: v.id, impact: v.impact, help: v.help, help_url: v.helpUrl, nodes: v.nodes.map((n: any) => ({ target: n.target, summary: n.failureSummary, html: n.html.slice(0, 240) })) })) }; });
  const grouped: Record<string, unknown[]> = {}; for (const v of result.violations) (grouped[(v as any).impact || "unknown"] ||= []).push(v); return { pass_count: result.passes, violations_by_impact: grouped };
});
addTool("dom_hierarchy", "Return heading outline, landmarks, reading order, and maximum DOM nesting depth.", {}, async () => (await ensurePage()).evaluate(() => ({ headings: [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")].map((e, order) => ({ level: Number(e.tagName[1]), text: e.textContent?.trim().slice(0, 180), order })), landmarks: [...document.querySelectorAll("header,nav,main,aside,footer,[role]")].map(e => ({ tag: e.tagName.toLowerCase(), role: e.getAttribute("role") || undefined, label: e.getAttribute("aria-label") || undefined, text: (e.textContent || "").trim().slice(0, 100) })).slice(0, 80), reading_order: [...document.querySelectorAll("h1,h2,h3,h4,h5,h6,main,nav,button,a,p")].slice(0, 80).map(e => ({ tag: e.tagName.toLowerCase(), text: ((e as HTMLElement).innerText || "").trim().replace(/\s+/g, " ").slice(0, 100) })), max_nesting_depth: (() => { let max=0; const walk=(n:Node,d:number)=>{max=Math.max(max,d); for(const c of n.childNodes) walk(c,d+1)}; walk(document.body,0); return max; })() })));
addTool("visual_hierarchy", "Rank visible elements by approximate visual weight from area, contrast, and position.", { limit: z.number().int().min(5).max(100).default(30) }, async ({ limit }) => (await ensurePage()).evaluate((limit:number) => [...document.querySelectorAll("h1,h2,h3,button,a,[role=button],img,section,header,main")].map((e: any) => { const r=e.getBoundingClientRect(),s=getComputedStyle(e); if(r.width<8||r.height<8||r.bottom<0||r.right<0) return null; const area=r.width*r.height, font=parseFloat(s.fontSize)||0, color=s.color, bg=s.backgroundColor; const weight=Math.round(Math.log2(area+1)*4 + font*1.3 + (parseInt(s.fontWeight,10)>500?12:0) + (r.top<innerHeight*.4?10:0)); return { tag:e.tagName.toLowerCase(), text:(e.innerText||e.alt||"").trim().replace(/\s+/g," ").slice(0,100), rect:{x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)}, weight, color, background:bg }; }).filter(Boolean).sort((a:any,b:any)=>b.weight-a.weight).slice(0,limit), limit));
addTool("measure_spacing", "Measure sibling gaps, margins and padding; report deviations from an 8px grid and section rhythm.", { selector: z.string().optional(), limit: z.number().int().min(1).max(100).default(40) }, async ({ selector, limit }) => (await ensurePage()).evaluate(({selector,limit}) => {
  const roots=selector?[...new Set([...document.querySelectorAll(selector)].map(e=>e.parentElement).filter(Boolean))]:[...document.querySelectorAll("main,section,nav,header,footer")];
  return roots.slice(0,30).map(root=>{
    const children=(selector?[...root.querySelectorAll(selector!)]:[...root.children]).filter((e:any)=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0}).slice(0,limit);
    const items=children.map((e:any)=>{const s=getComputedStyle(e),r=e.getBoundingClientRect();return{tag:e.tagName.toLowerCase(),text:(e.innerText||"").trim().replace(/\s+/g," ").slice(0,70),margin:{top:s.marginTop,right:s.marginRight,bottom:s.marginBottom,left:s.marginLeft},padding:{top:s.paddingTop,right:s.paddingRight,bottom:s.paddingBottom,left:s.paddingLeft},rect:{x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)}}});
    const gaps=children.slice(1).map((e:any,i:number)=>{const a=children[i].getBoundingClientRect(),b=e.getBoundingClientRect(),sameRow=Math.abs(a.top-b.top)<Math.min(a.height,b.height)*.5,gap=Math.round(sameRow?b.left-a.right:b.top-a.bottom);return{from:i,to:i+1,axis:sameRow?"horizontal":"vertical",gap_px:gap,off_8px_grid:gap>=0&&Math.min(gap%8,8-gap%8)>1}});
    const vertical=gaps.filter(g=>g.axis==="vertical"&&g.gap_px>=0).map(g=>g.gap_px).sort((a,b)=>a-b);const median=vertical.length?vertical[Math.floor(vertical.length/2)]:null;
    const gridValues=items.flatMap((item:any)=>[...Object.values(item.margin),...Object.values(item.padding)].map(v=>parseFloat(String(v))).filter(v=>Number.isFinite(v)));
    const offGrid=gridValues.filter(v=>Math.min(v%8,8-v%8)>1);
    return{root:root.tagName.toLowerCase(),selector:selector||undefined,items,gaps,grid:{sampled_spacing_values:gridValues.length,off_grid_values:offGrid.length,off_grid_examples:offGrid.slice(0,20)},section_rhythm:{vertical_gap_count:vertical.length,median_gap_px:median,spread_px:vertical.length?vertical[vertical.length-1]-vertical[0]:0}};
  });
}, {selector,limit}));
function luminance(rgb: number[]) { const v=rgb.map(x=>{x/=255;return x<=.04045?x/12.92:((x+.055)/1.055)**2.4}); return .2126*v[0]+.7152*v[1]+.0722*v[2]; }
addTool("contrast_scan", "Estimate WCAG contrast for text against its computed solid background; report text below 4.5:1 or large text below 3:1.", {}, async () => (await ensurePage()).evaluate(() => {
  const rgb=(c:string)=>{const m=c.match(/[\d.]+/g);return m&&m.length>=3?m.slice(0,3).map(Number):null}; const lum=(a:number[])=>{const v=a.map(x=>{x/=255;return x<=.04045?x/12.92:((x+.055)/1.055)**2.4});return .2126*v[0]+.7152*v[1]+.0722*v[2]};
  return [...document.querySelectorAll("body *")].slice(0,2000).flatMap((e:any)=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);if(!e.textContent?.trim()||r.width===0||r.height===0)return[];let bg=e;let bgrgb:[number,number,number]|null=null;while(bg&&bg!==document.documentElement){bgrgb=rgb(getComputedStyle(bg).backgroundColor) as any;if(bgrgb&&getComputedStyle(bg).backgroundColor!="rgba(0, 0, 0, 0)")break;bg=bg.parentElement} const fg=rgb(s.color);if(!fg||!bgrgb)return[];const a=lum(fg),b=lum(bgrgb),ratio=(Math.max(a,b)+.05)/(Math.min(a,b)+.05),large=parseFloat(s.fontSize)>=24||(parseFloat(s.fontSize)>=18.66&&Number(s.fontWeight)>=700);return ratio<(large?3:4.5)?[{tag:e.tagName.toLowerCase(),text:e.textContent.trim().replace(/\s+/g," ").slice(0,90),selector:e.id?`#${e.id}`:e.tagName.toLowerCase(),foreground:s.color,background:getComputedStyle(bg).backgroundColor,ratio:Number(ratio.toFixed(2)),threshold:large?3:4.5}]:[]}).slice(0,100);
}));
addTool("tap_target_scan", "Find visible interactive elements with dimensions smaller than 44 by 44 CSS pixels.", {}, async () => (await ensurePage()).evaluate(() => [...document.querySelectorAll("a,button,input,select,textarea,[role=button],[tabindex]")].flatMap((e:any)=>{const r=e.getBoundingClientRect();return r.width<1||r.height<1?[]:[{tag:e.tagName.toLowerCase(),text:(e.innerText||e.getAttribute("aria-label")||"").trim().slice(0,80),x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height),below_44:r.width<44||r.height<44}]}).filter(x=>x.below_44).slice(0,200)));
addTool("computed_styles", "Inspect typography, color, background, border, radius, spacing and box dimensions for matching elements.", { selector: z.string(), limit: z.number().int().min(1).max(50).default(10) }, async ({selector,limit}) => (await ensurePage()).evaluate(({selector,limit})=>[...document.querySelectorAll(selector)].slice(0,limit).map((e:any)=>{const s=getComputedStyle(e),r=e.getBoundingClientRect();return{text:(e.innerText||"").trim().replace(/\s+/g," ").slice(0,120),rect:{x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)},font_family:s.fontFamily,font_size:s.fontSize,font_weight:s.fontWeight,line_height:s.lineHeight,color:s.color,background_color:s.backgroundColor,border_radius:s.borderRadius,margin:s.margin,padding:s.padding}}),{selector,limit}));
addTool("slice_image", "Split an image into grid tiles; optional crop is [left,top,width,height]. Return coordinate bounds and output paths.", { path: z.string(), cols: z.number().int().min(1).max(12), rows: z.number().int().min(1).max(12), overlap: z.number().min(0).max(0.5).default(0.08), crop: z.tuple([z.number(),z.number(),z.number(),z.number()]).optional() }, async ({path:input,cols,rows,overlap,crop}) => {
  const source=path.resolve(projectRoot,input); const meta=await sharp(source).metadata(); if(!meta.width||!meta.height)throw new Error("Image dimensions unavailable");
  const region=crop||[0,0,meta.width,meta.height]; const tw=Math.ceil(region[2]/cols),th=Math.ceil(region[3]/rows),ox=Math.round(tw*overlap),oy=Math.round(th*overlap); await fs.mkdir(artifacts,{recursive:true});const tiles=[];
  for(let y=0;y<rows;y++)for(let x=0;x<cols;x++){const left=Math.max(0,Math.floor(region[0]+x*tw-ox)),top=Math.max(0,Math.floor(region[1]+y*th-oy)),right=Math.min(meta.width,Math.ceil(region[0]+(x+1)*tw+ox)),bottom=Math.min(meta.height,Math.ceil(region[1]+(y+1)*th+oy)),out=path.join(artifacts,`${Date.now()}-tile-${x}-${y}.jpg`);await sharp(source).extract({left,top,width:right-left,height:bottom-top}).jpeg({quality:90}).toFile(out);tiles.push({row:y,col:x,coordinates:{left,top,right,bottom},path:out});}
  return { source, dimensions:{width:meta.width,height:meta.height}, tiles };
});
addTool("annotate_image", "Draw numbered issue labels and boxes onto a screenshot and save an annotated copy.", { path:z.string(),boxes:z.array(z.object({x:z.number(),y:z.number(),width:z.number(),height:z.number(),label:z.string().optional()})).max(100) }, async ({path:input,boxes})=>{
  const source=path.resolve(projectRoot,input),meta=await sharp(source).metadata();if(!meta.width||!meta.height)throw new Error("Image dimensions unavailable");const svg=`<svg width="${meta.width}" height="${meta.height}" xmlns="http://www.w3.org/2000/svg">${boxes.map((b:{x:number;y:number;width:number;height:number;label?:string},i:number)=>`<rect x="${b.x}" y="${b.y}" width="${b.width}" height="${b.height}" fill="none" stroke="#ff3158" stroke-width="4"/><rect x="${b.x}" y="${Math.max(0,b.y-28)}" width="${Math.max(34,(b.label||String(i+1)).length*12+12)}" height="28" fill="#ff3158"/><text x="${b.x+7}" y="${Math.max(19,b.y-8)}" fill="white" font-family="sans-serif" font-size="18" font-weight="700">${(b.label||String(i+1)).replace(/[<>&"']/g,"")}</text>`).join("")}</svg>`;await fs.mkdir(artifacts,{recursive:true});const out=path.join(artifacts,`${Date.now()}-annotated.png`);await sharp(source).composite([{input:Buffer.from(svg)}]).png().toFile(out);return{path:out,width:meta.width,height:meta.height};
});
addTool("visual_diff", "Compare two screenshots pixel by pixel and save a highlighted difference overlay plus changed-pixel ratio.", { before:z.string(),after:z.string() }, async ({before,after})=>{
  const a=sharp(path.resolve(projectRoot,before)),b=sharp(path.resolve(projectRoot,after));const am=await a.metadata(),bm=await b.metadata();if(!am.width||!am.height||!bm.width||!bm.height)throw new Error("Image dimensions unavailable");const width=Math.min(am.width,bm.width),height=Math.min(am.height,bm.height);const ab=await a.resize(width,height).removeAlpha().raw().toBuffer(),bb=await b.resize(width,height).removeAlpha().raw().toBuffer(),diff=Buffer.alloc(ab.length);let changed=0;for(let i=0;i<ab.length;i+=3){const d=Math.max(Math.abs(ab[i]-bb[i]),Math.abs(ab[i+1]-bb[i+1]),Math.abs(ab[i+2]-bb[i+2]));if(d>24){changed++;diff[i]=255;diff[i+1]=Math.round(bb[i+1]*.25);diff[i+2]=Math.round(bb[i+2]*.25)}else{diff[i]=bb[i]*.55;diff[i+1]=bb[i+1]*.55;diff[i+2]=bb[i+2]*.55}}
  await fs.mkdir(artifacts,{recursive:true});const out=path.join(artifacts,`${Date.now()}-visual-diff.png`);await sharp(diff,{raw:{width,height,channels:3}}).png().toFile(out);return{path:out,width,height,changed_pixel_ratio:Number((changed/(width*height)).toFixed(4))};
});
addTool("forma_audit", "Send a screenshot and scrap.py-compatible telemetry to the OpenAI-compatible FORMA endpoint using the exact dataset prompt. Optional image tiles are audited separately.", { image:z.string(), telemetry:z.record(z.unknown()).optional(), tiles:z.array(z.string()).optional() }, async ({image,telemetry,tiles})=>{
  const credentials=await endpointCredentials();const base=credentials.base,secret=credentials.token;if(!base||!secret)throw new Error("FORMA endpoint is not configured. Set FORMA_URL and FORMA_TOKEN in the MCP client environment.");
  const parsedBase=new URL(base);if(parsedBase.protocol!=="https:"&&!(["localhost","127.0.0.1","::1"].includes(parsedBase.hostname)))throw new Error("FORMA endpoint must use HTTPS except for a local development endpoint.");
  const data=telemetry||await captureTelemetry(await ensurePage());
  const auditOne=async(file:string)=>{const content:any[]=[{type:"image_url",image_url:{url:await imageBase64(file)}},{type:"text",text:formatTrainingPrompt(data)}];let body:any,lastError:unknown;
    for(let attempt=0;attempt<3;attempt++){try{const response=await fetch(`${base}/v1/chat/completions`,{method:"POST",headers:{Authorization:`Bearer ${secret}`,"Content-Type":"application/json"},body:JSON.stringify({model:process.env.FORMA_MODEL||"forma",temperature:0.2,max_tokens:1200,messages:[{role:"user",content}] }),signal:AbortSignal.timeout(180000)});if(!response.ok){const message=`FORMA endpoint returned HTTP ${response.status}: ${(await response.text()).slice(0,500)}`;if(response.status<500)throw new Error(message);throw new Error(message);}body=await response.json();break;}catch(error){lastError=error;if(attempt===2){if(error instanceof TypeError||String(error).includes("TimeoutError")||String(error).includes("HTTP 401"))throw new Error(`FORMA endpoint is unavailable or the Kaggle session/token has expired. Run 'forma config' in another terminal to enter the new URL and token, then retry; the current coding-agent conversation can stay open. (${String(error).slice(0,250)})`);throw new Error(`FORMA request failed after 3 attempts: ${String(error).slice(0,500)}`);}await new Promise(resolve=>setTimeout(resolve,500*2**attempt));}}
    const raw=body.choices?.[0]?.message?.content;if(typeof raw!=="string")throw new Error("FORMA response has no assistant text");let match=raw.match(/\{[\s\S]*\}/),parsed=null;if(match){try{parsed=auditSchema.parse(JSON.parse(match[0]))}catch{}}
    return{raw,parsed,schema_valid:!!parsed};};
  const primary=await auditOne(image);const extra=[];for(const t of tiles||[])extra.push({image:t,...await auditOne(t)});
  const valid=[primary,...extra].map(x=>x.parsed).filter(Boolean) as Array<z.infer<typeof auditSchema>>;
  const mergedIssues: z.infer<typeof auditSchema>["issues"]=[];
  const terms=(s:string)=>new Set(s.toLowerCase().replace(/[^a-z0-9 ]/g," ").split(/\s+/).filter(x=>x.length>2));
  for(const report of valid)for(const issue of report.issues){
    const current=terms(`${issue.category} ${issue.element} ${issue.detail} ${issue.evidence}`);
    const duplicate=mergedIssues.some(existing=>{
      if(existing.category!==issue.category)return false;
      const other=terms(`${existing.element} ${existing.detail} ${existing.evidence}`);const union=new Set([...current,...other]).size;
      return [...current].filter(x=>other.has(x)).length/Math.max(1,union)>=0.78;
    });
    if(!duplicate)mergedIssues.push(issue);
  }
  const merged=valid.length?{...valid[0],issues:mergedIssues,scores:Object.fromEntries(Object.keys(valid[0].scores).map(key=>[key,Math.round(valid.reduce((n,r)=>n+r.scores[key as keyof typeof r.scores],0)/valid.length)])),summary:valid.length>1?`Combined audit across ${valid.length} screenshots/tiles. ${[...new Set(valid.map(r=>r.summary))].join(" ")}`:valid[0].summary}:null;
  return{...primary,parsed:merged,schema_valid:!!merged,tiles:extra,merge:{images_audited:valid.length,unique_issue_count:mergedIssues.length,deduplicated:valid.reduce((n,r)=>n+r.issues.length,0)-mergedIssues.length}};
});

const transport = new StdioServerTransport();
await server.connect(transport);
process.on("SIGINT", async () => { await browser?.close(); process.exit(0); });
