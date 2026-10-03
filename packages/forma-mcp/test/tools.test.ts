import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { formatTrainingPrompt } from "../src/prompt.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "../../../..");
test("FORMA prompt matches the training row prefix and Python JSON spacing", () => {
  assert.equal(formatTrainingPrompt({ body_font: "Inter", tap_targets: [40, 44], note: "café" }),
    "You are a professional UI/UX auditor. Analyze the attached website screenshot and produce a structured audit. First reason about it step by step inside a think block, then output the final JSON report as specified in your instructions.\n\nBrowser context (measured, authoritative — trust these over visual estimates):\n{\"body_font\": \"Inter\", \"tap_targets\": [40, 44], \"note\": \"café\"}");
});
function decode(result: any) {
  const content=result.content?.find((c:any)=>c.type==="text")?.text;
  assert.ok(content, "MCP tool must return compact JSON text");
  const value=JSON.parse(content);
  assert.equal(result.isError, undefined, value.error || "MCP tool returned an error");
  return value;
}

test("browser telemetry tools find known local fixture defects", async () => {
  const html=await readFile(path.join(projectRoot,"packages/forma-mcp/fixtures/defects.html"),"utf8");
  const http=createServer((_req,res)=>{res.writeHead(200,{"content-type":"text/html"});res.end(html);});
  await new Promise<void>(resolve=>http.listen(0,"127.0.0.1",resolve));
  const address=http.address();assert.ok(address&&typeof address!=="string");
  const transport=new StdioClientTransport({command:process.execPath,args:[path.join(projectRoot,"packages/forma-mcp/dist/src/index.js")],env:{...process.env,FORMA_PROJECT_ROOT:projectRoot} as Record<string,string>});
  const client=new Client({name:"forma-mcp-fixture-test",version:"0.1.0"});
  try {
    await client.connect(transport);
    const opened=decode(await client.callTool({name:"browser_open",arguments:{url:`http://127.0.0.1:${address.port}`,viewport:"mobile",allow_private:true}}));
    assert.match(opened.url,/127\.0\.0\.1/);
    const telemetry=decode(await client.callTool({name:"capture_telemetry",arguments:{}}));
    for(const key of ["console_errors","page_crashes","network_failures","http_errors","measured","fonts","responsive_overflow","axe"]) assert.ok(key in telemetry,`telemetry schema missing ${key}`);
    assert.equal(telemetry.measured.body_size,10);
    assert.equal(telemetry.measured.images_missing_alt,1);
    assert.equal(telemetry.responsive_overflow.overflow_x_390,true);
    assert.ok(telemetry.console_errors.some((x:any)=>x.text.includes("fixture console defect")));
    const targets=decode(await client.callTool({name:"tap_target_scan",arguments:{}}));
    assert.ok(targets.some((x:any)=>x.text==="+"||x.text==="Open menu"));
    const axe=decode(await client.callTool({name:"axe_scan",arguments:{}}));
    assert.ok(Object.values(axe.violations_by_impact).flat().length>0);
    const shot=decode(await client.callTool({name:"screenshot",arguments:{full_page:true}}));
    assert.ok(shot.path.includes(path.join(".forma","artifacts")));
    assert.equal(typeof shot.width,"number");
  } finally {
    await client.close();
    await new Promise<void>(resolve=>http.close(()=>resolve()));
  }
});
