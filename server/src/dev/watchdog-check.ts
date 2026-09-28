import assert from "node:assert/strict";
process.env.SITES = JSON.stringify([{ id: "test", repo: "https://example.com/test.git", branch: "main", domain: "test.example" }]);
const { turnWatchdog } = await import("../session-policy.js");
const { parseStreamLine, spawnEnv } = await import("../claude.js");
const { SITES } = await import("../sites.js");
const tool = (i: number, command = "echo ok") => parseStreamLine(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: `tool-${i}`, name: "Bash", input: { command } }] } })).events.find(e => e.t === "tool")!;
let guard = turnWatchdog();
for (let i = 0; i < 19; i++) assert.equal(guard(tool(i)), null);
assert.equal(guard(tool(18)), null, "replayed tool id does not count twice");
assert.equal(guard(tool(19)), "Stopped: 20 identical tool calls in a row — polling loop");
guard = turnWatchdog();
for (let i = 0; i < 19; i++) assert.equal(guard(tool(i)), null);
assert.equal(guard(tool(19, "true")), null);
for (let i = 20; i < 39; i++) assert.equal(guard(tool(i)), null);
assert.equal(guard({ t: "usage", contextTokens: 300000 }), null);
assert.equal(guard({ t: "usage", contextTokens: 300001 }), "Stopped: context passed 300k tokens");
const parsed = parseStreamLine(JSON.stringify({ type: "assistant", message: { id: "m1", content: [], usage: { input_tokens: 10, cache_read_input_tokens: 200000, cache_creation_input_tokens: 100000, output_tokens: 3000 } } })).events[0];
assert.equal(parsed?.t === "usage" && parsed.contextTokens, 300010, "context excludes output");
for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "CODEX_API_KEY"]) {
  const old = process.env[key];
  process.env[key] = "synthetic-test-value";
  assert.equal(spawnEnv(SITES[0]!, { [key]: "synthetic-overlay" })[key], undefined);
  if (old === undefined) delete process.env[key]; else process.env[key] = old;
}
console.log("watchdog-check OK");

// Exercise actual runners and durable PATCHes with fake executables, never providers.
const { mkdtemp, writeFile, chmod } = await import("node:fs/promises");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const { spawnSync } = await import("node:child_process");
const integrationRoot = await mkdtemp(join(tmpdir(), "ak-watchdog-spawn-"));
// Keep checkout sync on the production path; git is an inert local fixture.
const fakeGit = join(integrationRoot, "git");
await writeFile(fakeGit, `#!${process.execPath}\nprocess.stdout.write('fixture-head\\n');\n`);
await chmod(fakeGit, 0o755);
const fake = join(integrationRoot, "claude.cjs");
await writeFile(fake, `#!${process.execPath}
const fs = require('node:fs');
const readline = require('node:readline');
const mode = process.env.MODE;
fs.writeFileSync(process.env.ARGS_FILE, JSON.stringify(process.argv.slice(2)));
fs.appendFileSync(process.env.ARGS_FILE+'.history', JSON.stringify({pid:process.pid})+'\\n');
const send = v => console.log(JSON.stringify(v));
const call = (i, tokens=4000) => send({type:'assistant',message:{id:'m'+i,usage:{input_tokens:tokens,output_tokens:10},content:[{type:'tool_use',id:'t'+i,name:'Bash',input:{command:'echo ok'}}]}});
const result = cost => send({type:'result',result:'done',total_cost_usd:cost});
if (mode.startsWith('streaming')) {
 let lines=0;
 const input=readline.createInterface({input:process.stdin});
 input.on('line', line => {
  lines++;
  if(lines===1) {
   if(mode==='streaming-results') {call(0); result(.42);}
   else {for(let i=0;i<19;i++) call(i,150001); if(mode==='streaming-boundary') result(.42);}
  } else {
   fs.writeFileSync(process.env.ARGS_FILE+'.received',JSON.stringify({pid:process.pid,line,lines}));
   if(mode==='streaming-results') {call(1); result(.84);}
   else call(19,150001);
  }
 });
 input.on('close',()=>process.exit(0));
} else {
 for(let i=0;i<(mode==='loop'?20:1);i++) call(i,mode==='context'?300001:4000);
 if(mode==='error') {send({type:'result',is_error:true,result:'synthetic failure',total_cost_usd:.42});process.exit(1);}
 setInterval(()=>{},1000);
}
`);
await chmod(fake, 0o755);
const driver = join(integrationRoot, "driver.mjs");
await writeFile(driver, `
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
process.env.SUPABASE_URL='https://fixture.invalid';
process.env.SUPABASE_SERVICE_KEY='synthetic-test-only';
const patches=[];
globalThis.fetch=async (url,init)=>{if(init?.method==='PATCH')patches.push(JSON.parse(init.body));return new Response(null,{status:204});};
const {runMessageJob,runStreamingSession,InputChannel,conversationIdFor}=await import(${JSON.stringify(new URL('../claude.ts', import.meta.url).href)});
const {startJob,cancelJob,jobSnapshot}=await import(${JSON.stringify(new URL('../jobs.ts', import.meta.url).href)});
const {getSite}=await import(${JSON.stringify(new URL('../sites.ts', import.meta.url).href)});
const {checkoutPath}=await import(${JSON.stringify(new URL('../checkouts.ts', import.meta.url).href)});
const site=getSite('test');
await mkdir(checkoutPath('test')+'/.git',{recursive:true});
site.sessionIdleMs=100;
const mode=process.env.MODE, streaming=mode.startsWith('streaming');
const ac=new AbortController(), input=new InputChannel();
const job=await startJob({streaming,input,siteId:'test',page:'/',prompt:'test',abort:()=>ac.abort(),makeGen:preLock=>{
 const opts={text:'first',page:'/',attachmentPaths:[],preLock,cron:mode==='context',forceFresh:'boot requeue'};
 return streaming?runStreamingSession(site,opts,input,ac.signal):runMessageJob(site,opts,ac.signal);
}});
let sent=false;
const deadline=Date.now()+5000;
while(Date.now()<deadline) {
 const snapshot=jobSnapshot(job.jobId);
 if(mode==='cancel' && snapshot?.result?.usage) cancelJob(job.jobId);
 const ready=mode==='streaming-live'?snapshot?.status_line?.phase==='tool':snapshot?.result?.reply==='done';
 if(streaming && ready && !sent) {
  if(mode==='streaming-live') assert.equal(snapshot.result?.reply,undefined,'steering arrives BEFORE the first result');
  assert.ok(input.push('steer now'));sent=true;
 }
 if(snapshot && ['done','error','interrupted'].includes(snapshot.status) && snapshot.result?.usage) break;
 await new Promise(r=>setTimeout(r,5));
}
await new Promise(r=>setTimeout(r,50));
const snapshot=jobSnapshot(job.jobId);
assert.ok(snapshot.result.usage.input_tokens>0);
assert.deepEqual(patches.at(-1).result.usage,snapshot.result.usage,'durable PATCH preserves observed usage');
if(mode==='error') assert.equal(snapshot.result.usage.cost_usd,.42);
else if(mode==='streaming-results') {
 assert.equal(snapshot.status,'done');
 assert.equal(snapshot.result.usage.cost_usd,.84,'CLI process total is not added twice');
 assert.equal(snapshot.result.usage.input_tokens,8000);
} else {
 assert.equal(snapshot.result.usage.cost_usd,null,'no reported total for killed work');
 assert.equal(snapshot.result.usage.cost_estimated,undefined);
 if(mode==='cancel') assert.equal(snapshot.error.kind,'stopped');
 else assert.match(snapshot.error.detail,mode==='context'?/context passed 300k/:/20 identical/);
}
const args=JSON.parse(await readFile(process.env.ARGS_FILE,'utf8'));
assert.ok(args.includes('--session-id'));assert.ok(!args.includes('--resume'));
assert.equal(args[args.indexOf('--max-budget-usd')+1],'10');
if(streaming) {
 assert.ok(sent);
 const history=(await readFile(process.env.ARGS_FILE+'.history','utf8')).trim().split('\\n').map(JSON.parse);
 const received=JSON.parse(await readFile(process.env.ARGS_FILE+'.received','utf8'));
 assert.equal(history.length,1,'one process for the whole open job');
 assert.equal(received.pid,history[0].pid,'steering reached the same process');
 assert.equal(received.lines,2);
 assert.match(received.line,/steer now/);
 assert.equal(await conversationIdFor('test'),job.conversationId,'no mid-job policy rotation');
}
`);
for (const mode of ["loop", "context", "error", "cancel", "streaming-live", "streaming-boundary", "streaming-results"]) {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${integrationRoot}:${process.env.PATH}`, AGENT_DATA_DIR: join(integrationRoot, mode), HOME: integrationRoot, CLAUDE_BIN: fake, ARGS_FILE: join(integrationRoot, `${mode}-args.json`), MODE: mode, SITES: JSON.stringify([{ id: "test", repo: "https://example.com/test.git", branch: "main", domain: "test.example" }]) };
  for (const key of ["SUPABASE_URL", "SUPABASE_SERVICE_KEY", "GH_TOKEN", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "CODEX_API_KEY"]) delete env[key];
  const run = spawnSync(process.execPath, ["--import", "tsx", driver], { env, encoding: "utf8", timeout: 10000 });
  assert.equal(run.status, 0, `${mode}: ${run.stderr || run.stdout}`);
}
console.log("watchdog-check OK — live stdin, process-wide guard, observed tokens/null costs, CLI totals and durable writes");
