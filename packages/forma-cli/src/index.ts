#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { runAgent } from "./agent.js";
import { ui } from "./ui.js";

const homeConfig = path.join(os.homedir(), ".forma", "config.json");
type Config = { formaUrl: string; formaToken: string; coding: { provider: string; baseUrl: string; apiKey: string; model: string }; ui?: { theme?: string; animations?: boolean; progress?: boolean }; updatedAt: string };
const args = process.argv.slice(2);
const require = createRequire(import.meta.url);
const cliVersion: string = require("../package.json").version;
function resolveMcpEntrypoint() { return require.resolve("@forma-ai/forma-mcp/dist/src/index.js"); }
function banner() { ui.banner(cliVersion, process.cwd()); }
async function readConfig(): Promise<Config | undefined> {
  let config: Config | undefined;
  try { config = JSON.parse(await fs.readFile(homeConfig, "utf8")); } catch { }
  const envBase=process.env.FORMA_CODING_BASE_URL||process.env.OPENAI_BASE_URL||(process.env.OLLAMA_BASE_URL?`${process.env.OLLAMA_BASE_URL.replace(/\/$/,"")}/v1`:undefined);
  if(!config&&!(process.env.FORMA_URL||process.env.FORMA_TOKEN))return;
  config ||= {formaUrl:"",formaToken:"",coding:{provider:"openai-compatible",baseUrl:"",apiKey:"",model:""},updatedAt:new Date().toISOString()};
  config.formaUrl=process.env.FORMA_URL||config.formaUrl;config.formaToken=process.env.FORMA_TOKEN||config.formaToken;
  config.coding.provider=process.env.FORMA_CODING_PROVIDER||(process.env.OLLAMA_BASE_URL?"ollama":config.coding.provider);
  config.coding.baseUrl=envBase||config.coding.baseUrl;config.coding.apiKey=process.env.FORMA_CODING_API_KEY||process.env.OPENAI_API_KEY||config.coding.apiKey;config.coding.model=process.env.FORMA_CODING_MODEL||process.env.OPENAI_MODEL||config.coding.model;
  return config;
}
async function saveConfig(config: Config) { await fs.mkdir(path.dirname(homeConfig), { recursive: true, mode: 0o700 }); await fs.writeFile(homeConfig, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 }); await fs.chmod(homeConfig, 0o600); }
async function setup(old?: Config) {
  banner(); console.log("Connect your FORMA audit endpoint and coding model. Secrets stay in ~/.forma/config.json.\n");
  const rl = createInterface({ input, output });
  try {
    const formaUrl = (await rl.question(`Kaggle OpenAI-compatible API base URL${old ? ` [${old.formaUrl}]` : ""}: `)).trim() || old?.formaUrl || "";
    const formaToken = (await rl.question(`FORMA bearer token${old ? " [leave blank to keep saved token]" : ""}: `)).trim() || old?.formaToken || "";
    const provider = (await rl.question(`Coding provider (groq / openai-compatible / ollama) [${old?.coding.provider || "openai-compatible"}]: `)).trim() || old?.coding.provider || "openai-compatible";
    const defaultBase = provider === "ollama" ? "http://localhost:11434/v1" : provider === "groq" ? "https://api.groq.com/openai/v1" : "https://api.openai.com/v1";
    const baseUrl = (await rl.question(`Coding API base URL [${old?.coding.baseUrl || defaultBase}]: `)).trim() || old?.coding.baseUrl || defaultBase;
    const apiKey = (await rl.question(`Coding API key${old ? " [leave blank to keep saved key]" : ""}: `)).trim() || old?.coding.apiKey || (provider === "ollama" ? "ollama" : "");
    const model = (await rl.question(`Coding model ID [${old?.coding.model || (provider === "ollama" ? "qwen2.5-coder:14b" : "gpt-4.1-mini")}]: `)).trim() || old?.coding.model || (provider === "ollama" ? "qwen2.5-coder:14b" : "gpt-4.1-mini");
    if (!formaUrl || !formaToken || !baseUrl || !apiKey || !model) throw new Error("Endpoint, token, coding model URL, key, and model ID are required.");
    const config: Config = { formaUrl: formaUrl.replace(/\/$/, ""), formaToken, coding: { provider, baseUrl: baseUrl.replace(/\/$/, ""), apiKey, model }, ui: old?.ui || { theme: "forma", animations: true, progress: true }, updatedAt: new Date().toISOString() };
    await health(config); await saveConfig(config); console.log(`\nFORMA endpoint is online. Saved private config to ${homeConfig} (mode 0600).`); return config;
  } finally { rl.close(); }
}
async function health(config: Config) {
  const response = await fetch(`${config.formaUrl}/health`, { headers: { Authorization: `Bearer ${config.formaToken}` }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`FORMA health check failed (HTTP ${response.status}); check the Kaggle URL and bearer token.`);
  const data: any = await response.json(); console.log(`FORMA status: ${data.status || "healthy"}${data.model ? ` · ${data.model}` : ""}`); return data;
}
async function requireConfig() { return (await readConfig()) || setup(); }
function jsonText(result: any) { const first = result?.content?.find((x: any) => x.type === "text")?.text; if (!first) throw new Error("MCP tool returned no text result"); const parsed = JSON.parse(first); if (result.isError || parsed.error) throw new Error(parsed.error || "MCP tool failed"); return parsed; }
async function callTools<T>(config: Config, cwd: string, action: (call: (name: string, arguments_: Record<string, unknown>) => Promise<any>) => Promise<T>) {
  const mcpEntrypoint = resolveMcpEntrypoint();
  const transport = new StdioClientTransport({ command: process.execPath, args: [mcpEntrypoint], env: { ...process.env, FORMA_PROJECT_ROOT: cwd, FORMA_URL: config.formaUrl, FORMA_TOKEN: config.formaToken, FORMA_CONFIG_PATH:homeConfig } as Record<string,string> });
  const client = new Client({ name: "forma-cli", version: "0.3.0" }); await client.connect(transport);
  try {
    return await action(async (name, arguments_) => {
      // MCP SDK defaults to 60s. Browser navigation/screenshot can exceed that,
      // and FORMA inference may retry several times on a Kaggle GPU.
      const timeout = name === "forma_audit" ? 600_000 : name === "lighthouse" ? 240_000 : 180_000;
      const result = await client.callTool(
        { name, arguments: arguments_ },
        undefined,
        { timeout, maxTotalTimeout: timeout + 30_000 },
      );
      return jsonText(result);
    });
  }
  finally { await client.close(); }
}
function parseAudit(raw: any) { return raw.parsed || null; }
async function audit(config: Config, url: string, cwd = process.cwd(), includeLighthouse = false, headed = false) {
  ui.configure(config.ui || {});
  return callTools(config, cwd, async call => {
    const totalSteps = 13 + Number(includeLighthouse); let complete = 0;
    const step = () => ui.progress("Audit progress", ++complete, totalSteps);
    let opened;
    try { opened = await ui.spin("Opening website", () => call("browser_open", { url, viewport: "desktop", allow_private: false, headed })); }
    catch (error) {
      const message=error instanceof Error?error.message:String(error);
      if (!/local\/private|private network/i.test(message)) throw error;
      const rl=createInterface({input,output});
      try { const consent=(await rl.question("This URL resolves to a local/private host. Continue only if this is your own development server? [y/N] ")).trim().toLowerCase(); if(consent!=="y"&&consent!=="yes")throw new Error("Browser navigation cancelled."); }
      finally { rl.close(); }
      opened = await ui.spin("Opening website", () => call("browser_open", { url, viewport: "desktop", allow_private: true, headed }));
    }
    step();
    const telemetry = await ui.spin("Collecting browser and performance data", () => call("capture_telemetry", {})); step();
    const diagnostics: Record<string, any> = {};
    const checks: Array<[string, string]> = [
      ["page_snapshot", "Reviewing content and information architecture"], ["dom_hierarchy", "Checking headings and landmarks"],
      ["axe_scan", "Checking accessibility rules"], ["contrast_scan", "Measuring text contrast"], ["tap_target_scan", "Checking touch targets"],
      ["form_scan", "Reviewing forms and labels"], ["link_check", "Checking link labels and destinations"],
      ["visual_hierarchy", "Measuring visual hierarchy"], ["measure_spacing", "Measuring layout rhythm"],
    ];
    for (const [name, label] of checks) {
      const options = name === "page_snapshot" ? { max_items: 80 } : name === "visual_hierarchy" ? { limit: 30 } : name === "measure_spacing" ? { limit: 30 } : {};
      diagnostics[name] = await ui.spin(label, () => call(name, options)); step();
    }
    if (includeLighthouse) { diagnostics.lighthouse = await ui.spin("Running Lighthouse", () => call("lighthouse", { url, categories: ["performance", "accessibility", "best-practices", "seo"], allow_private: false })); step(); }
    const shot = await ui.spin("Capturing full page", () => call("screenshot", { full_page: true })); step();
    const report = await ui.spin("Generating visual UI/UX review", () => call("forma_audit", { image: shot.path, telemetry })); step();
    return { url: opened.url, screenshot: shot, telemetry, diagnostics, raw: report.raw, audit: parseAudit(report), schema_valid: report.schema_valid };
  });
}
function isLocal(raw: string) { try { const h = new URL(raw).hostname; return h === "localhost" || h.endsWith(".localhost") || h === "127.0.0.1" || h === "::1"; } catch { return false; } }
function mdReport(result: any) {
  const a=result.audit;if(!a)return `# FORMA audit\n\nThe endpoint returned output that did not match the trained report schema. See the JSON report for raw output.\n`;
  return `# FORMA UI/UX audit\n\n**Page:** ${result.url}  \n**Screenshot:** \`${result.screenshot.path}\`  \n**Schema valid:** ${result.schema_valid}\n\n${a.summary}\n\n## Scores\n\n| Accessibility | Typography | Hierarchy | Color | Spacing | Element sizing |\n|---:|---:|---:|---:|---:|---:|\n| ${a.scores.accessibility} | ${a.scores.typography} | ${a.scores.hierarchy} | ${a.scores.color} | ${a.scores.spacing} | ${a.scores.element_sizing} |\n\n## Issues\n\n${a.issues.map((i:any,n:number)=>`### ${n+1}. ${i.element} · ${i.severity}\n\n**${i.category}** — ${i.evidence}\n\n${i.detail}\n\n**Suggested direction:** ${i.suggestion}`).join("\n\n")}\n\n*Page type: ${a.page_type}*\n`;
}
async function writeAudit(result: any, base = path.join(process.cwd(), ".forma", "reports", `audit-${Date.now()}`)) {
  await fs.mkdir(path.dirname(base), { recursive: true }); await fs.writeFile(`${base}.json`, JSON.stringify(result, null, 2)); await fs.writeFile(`${base}.md`, mdReport(result)); return { json: `${base}.json`, markdown: `${base}.md` };
}
function normalize(s: string) { return s.toLowerCase().replace(/https?:\/\/\S+/g," ").replace(/[^a-z0-9 ]/g," ").replace(/\s+/g," ").trim(); }
function similarity(a:string,b:string) { const aa=new Set(normalize(a).split(" ").filter(x=>x.length>3)),bb=new Set(normalize(b).split(" ").filter(x=>x.length>3));if(!aa.size&&!bb.size)return 1;return [...aa].filter(x=>bb.has(x)).length/Math.max(1,new Set([...aa,...bb]).size); }
async function evaluateFolder(config: Config, folder: string, groundTruth?: string, entriesFile?: string, labelsFile?: string) {
  const files=(await fs.readdir(folder,{withFileTypes:true})).filter(x=>x.isFile()&&/\.(png|jpe?g|webp)$/i.test(x.name)).map(x=>path.join(folder,x.name)).sort();
  if(!files.length)throw new Error(`No PNG/JPG/WebP screenshots found in ${folder}`);
  const readLines=async(file?:string)=>file?(await fs.readFile(file,"utf8")).split(/\r?\n/).filter(Boolean).flatMap(line=>{try{return[JSON.parse(line)]}catch{return[]}}):[];
  const entries=new Map<string,any>(),labelsById=new Map<string,any>(),truthByName=new Map<string,any>();
  for(const e of await readLines(entriesFile))if(e.image_path)entries.set(path.basename(e.image_path),e);
  for(const l of await readLines(labelsFile))if(l.id)labelsById.set(l.id,l.answer||l);
  for(const row of await readLines(groundTruth)){const name=path.basename(row.image||row.image_path||"");if(name)truthByName.set(name,row.answer||row);}
  const outputs:any[]=[];
  await callTools(config,process.cwd(),async call=>{
    for(const image of files){
      const name=path.basename(image),entry=entries.get(name),truth=truthByName.get(name)||(entry&&labelsById.get(entry.id));
      try{const r:any=await call("forma_audit",{image,telemetry:entry?.devtools||truth?.devtools||{}});const a=parseAudit(r);outputs.push({image:name,valid:!!a,issues:a?.issues||[],scores:a?.scores||{},summary:a?.summary||"",raw:r.raw,truth:truth?.answer||truth,telemetry:entry?.devtools||truth?.devtools||null});console.log(`${outputs.length}/${files.length} ${name} · ${a?"valid schema":"invalid schema"}`);}
      catch(error){outputs.push({image:name,valid:false,issues:[],scores:{},summary:"",error:String(error),truth,telemetry:entry?.devtools||truth?.devtools||null});console.log(`${outputs.length}/${files.length} ${name} · request failed`);}
    }
  });
  const cats=(xs:any[])=>new Set(xs.map(x=>`${x.category}|${x.severity}`));
  const overlaps=outputs.flatMap(o=>{if(!o.truth?.issues)return[];const expected=cats(o.truth.issues),actual=cats(o.issues),common=[...actual].filter(x=>expected.has(x));return[{image:o.image,precision:common.length/Math.max(1,actual.size),recall:common.length/Math.max(1,expected.size),matched:common.length}];});
  const similarPairs:any[]=[];for(let i=0;i<outputs.length;i++)for(let j=i+1;j<outputs.length;j++){const score=similarity(outputs[i].summary,outputs[j].summary);if(score>=.72)similarPairs.push({a:outputs[i].image,b:outputs[j].image,similarity:Number(score.toFixed(2))});}
  const numericEvidence=outputs.map(o=>/\b\d+(?:\.\d+)?\s?(?:px|%|:1|ms|×|x)\b/i.test(o.issues.map((x:any)=>`${x.evidence} ${x.detail}`).join(" ")));
  const genericElements=new Set(["page","layout","text","body text","secondary text","primary content","some controls","buttons","navigation","cards","content","interface"]);
  const genericEvidence=outputs.map(o=>o.issues.filter((i:any)=>genericElements.has(String(i.element).toLowerCase())||String(i.evidence).length<25).length);
  const phraseOwners=new Map<string,Set<string>>();for(const o of outputs){const words=normalize(`${o.summary} ${o.issues.map((i:any)=>i.detail).join(" ")}`).split(" ");const phrases=new Set<string>();for(let i=0;i<words.length-2;i++)phrases.add(words.slice(i,i+3).join(" "));for(const phrase of phrases)if(phrase.length>12){if(!phraseOwners.has(phrase))phraseOwners.set(phrase,new Set());phraseOwners.get(phrase)!.add(o.image);}}
  const repeatedPhrases=[...phraseOwners].filter(([,owners])=>owners.size>=Math.max(2,Math.ceil(outputs.length*.6))).map(([phrase,owners])=>({phrase,pages:owners.size}));
  const telemetryContradictions=outputs.flatMap(o=>{const t=o.telemetry?.measured,claims=o.issues.map((i:any)=>`${i.element} ${i.evidence} ${i.detail}`).join(" "),flags:string[]=[];
    const fontClaims=[...claims.matchAll(/(?:body|font|text)[^\n.]{0,28}?(\d{1,2}(?:\.\d+)?)\s?px/gi)];for(const m of fontClaims)if(Number.isFinite(Number(t?.body_size))&&Math.abs(Number(m[1])-Number(t.body_size))>=4)flags.push(`Claim says about ${m[1]}px; measured body size is ${t.body_size}px.`);
    const tapClaim=claims.match(/(?:target|button|control)[^\n.]{0,30}?(?:under|below|less than|<)\s?(\d{2})\s?px?/i);const targetSizes=(t?.tap_targets||[]).filter((x:any)=>x.w>0&&x.h>0).map((x:any)=>Math.min(x.w,x.h));if(tapClaim&&targetSizes.length&&Math.min(...targetSizes)>=Number(tapClaim[1]))flags.push(`Claim says a target is below ${tapClaim[1]}px; smallest sampled target is ${Math.min(...targetSizes)}px.`);
    if(/horizontal overflow|overflows? horizontally/i.test(claims)){const responsive=o.telemetry?.responsive_overflow;const vals=[1920,768,390].map(w=>responsive?.[`overflow_x_${w}`]);if(vals.length&&vals.every(v=>v===false))flags.push("Claims horizontal overflow, but all measured viewport overflow checks are false.");}
    return flags.map(message=>({image:o.image,message}));});
  const validCount=outputs.filter(x=>x.valid).length;
  const report={total:outputs.length,schema_validity:{valid:validCount,invalid:outputs.length-validCount,rate:validCount/outputs.length},issue_count_range:{within_3_to_8:outputs.filter(x=>x.issues.length>=3&&x.issues.length<=8).length,total:outputs.length,counts:outputs.map(x=>({image:x.image,count:x.issues.length}))},score_key_coverage:{complete:outputs.filter(x=>["accessibility","typography","hierarchy","color","spacing","element_sizing"].every(k=>typeof x.scores[k]==="number")).length,total:outputs.length},ground_truth_overlap:{matched_pages:overlaps.length,mean_precision:overlaps.length?overlaps.reduce((n,x)=>n+x.precision,0)/overlaps.length:null,mean_recall:overlaps.length?overlaps.reduce((n,x)=>n+x.recall,0)/overlaps.length:null,per_page:overlaps},boilerplate:{near_identical_summaries:similarPairs,repeated_phrases:repeatedPhrases,outputs_with_numeric_evidence:numericEvidence.filter(Boolean).length,outputs_without_element_specific_evidence:genericEvidence.filter((n,i)=>outputs[i].issues.length===0||n/outputs[i].issues.length>=.5).length,total:outputs.length,generic_warning:similarPairs.length>0||repeatedPhrases.length>0||numericEvidence.filter(Boolean).length<outputs.length/2},telemetry_cross_check:{contradictions:telemetryContradictions,pages_with_telemetry:outputs.filter(x=>x.telemetry).length,note:"Heuristic cross-check; body font and sampled tap targets are compared only when source telemetry is supplied."},results:outputs};
  const out=path.join(process.cwd(),".forma","reports",`eval-${Date.now()}.json`);await fs.mkdir(path.dirname(out),{recursive:true});await fs.writeFile(out,JSON.stringify(report,null,2));return{...report,report_path:out};
}
async function main() {
  const command=args[0];
  try {
    if(command==="--version"||command==="-v"){console.log("forma 0.3.0");return;}
    if(command==="config"){const current=await readConfig();if(args[1]==="show"){if(!current)throw new Error("No config exists; run forma config.");console.log(JSON.stringify({...current,formaToken:"[redacted]",coding:{...current.coding,apiKey:"[redacted]"}},null,2));return;}await setup(current);return;}
    if(command==="update"){
      const win=process.platform==="win32";const child=win?spawn("powershell.exe",["-NoProfile","-ExecutionPolicy","Bypass","-Command","iwr -useb https://raw.githubusercontent.com/EgoisticCoder/Forma/main/install.ps1 | iex"],{stdio:"inherit"}):spawn("sh",["-c","curl -fsSL https://raw.githubusercontent.com/EgoisticCoder/Forma/main/install.sh | sh"],{stdio:"inherit"});
      await new Promise<void>((resolve,reject)=>{child.on("close",c=>c===0?resolve():reject(new Error(`FORMA update failed (exit ${c}).`)));child.on("error",reject);});return;
    }
    if(command==="uninstall"){
      await new Promise<void>((resolve,reject)=>{const p=spawn("npm",["uninstall","--global","@forma-ai/forma","@forma-ai/forma-mcp"],{stdio:"inherit"});p.on("close",c=>c===0?resolve():reject(new Error(`npm uninstall exited ${c}`)));p.on("error",reject);});
      console.log(`Removed Forma packages. Local settings remain at ${homeConfig}; delete ~/.forma if you also want to remove saved credentials.`);return;
    }
    if(command==="audit"){const url=args[1];if(!url)throw new Error("Usage: forma audit <url> [--headed] [--lighthouse]");const config=await requireConfig();const result=await audit(config,url,process.cwd(),args.includes("--lighthouse"),args.includes("--headed"));const paths=await writeAudit(result);console.log(mdReport(result));console.log(`\nSaved ${paths.json} and ${paths.markdown}`);return;}
    if(command==="eval"){const folder=args[1];if(!folder)throw new Error("Usage: forma eval <screenshots-folder> [--ground-truth file.jsonl] [--entries entries.jsonl --labels labels.jsonl]");const value=(flag:string)=>{const i=args.indexOf(flag);return i>=0?args[i+1]:undefined;};const result=await evaluateFolder(await requireConfig(),folder,value("--ground-truth"),value("--entries"),value("--labels"));console.log(JSON.stringify({...result,results:undefined},null,2));return;}
    if(command==="help"||command==="--help"||command==="-h"){console.log("FORMA — UI-aware coding agent\n\nUsage:\n  forma [--url URL --token TOKEN] [--workspace DIR]\n  forma audit <url> [--headed] [--lighthouse]\n  forma eval <screenshots-folder> [--ground-truth file.jsonl] [--entries entries.jsonl --labels labels.jsonl]\n  forma config [show]\n  forma update | uninstall\n\nInteractive commands: /help /clear /status /tools /mcp /theme /settings /model /compact /todos /permissions /exit\nAsk FORMA to show the page in a visible browser, inspect its DOM or console, or operate controls with approval. forma audit opens an isolated Chromium context; --headed displays its window.");return;}
    const urlFlag=args.indexOf("--url"),tokenFlag=args.indexOf("--token"),workspaceFlag=args.indexOf("--workspace");
    let config=await readConfig();if(urlFlag>=0||tokenFlag>=0){if(!config)config={formaUrl:"",formaToken:"",coding:{provider:"openai-compatible",baseUrl:"https://api.openai.com/v1",apiKey:"",model:"gpt-4.1-mini"},updatedAt:new Date().toISOString()};config.formaUrl=urlFlag>=0?args[urlFlag+1]:config.formaUrl;config.formaToken=tokenFlag>=0?args[tokenFlag+1]:config.formaToken;if(!config.formaUrl||!config.formaToken)throw new Error("Both --url and --token are required on first setup.");await health(config);await saveConfig(config);}
    if(!config||!config.formaUrl||!config.formaToken||!config.coding.baseUrl||!config.coding.apiKey||!config.coding.model)config=await setup(config);const cwd=workspaceFlag>=0?path.resolve(args[workspaceFlag+1]):process.cwd();
    await runAgent(config,cwd);
  } catch(error) { console.error(`FORMA: ${error instanceof Error?error.message:String(error)}`); process.exitCode=1; }
}
main();
