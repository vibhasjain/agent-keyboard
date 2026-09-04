// Dev check for the job admission scheduler: per-site serialization, cross-site
// parallelism, worker cap, priority lane, queued-cancel reaping. Run:
//   AK_MAX_WORKERS=2 npx tsx src/dev/scheduler-check.ts
import { startJob, listActive, cancelJob } from "../jobs.js";
import type { Frame } from "../claude.js";

const log: string[] = [];
const t0 = Date.now();
const stamp = () => `${String(Date.now() - t0).padStart(4)}ms`;

function fakeGen(tag: string, holdMs: number) {
  return async function* (preLock: () => void): AsyncGenerator<Frame> {
    log.push(`${stamp()} ADMIT ${tag}`);
    try {
      yield ["status", { phase: "syncing", detail: tag }];
      await new Promise((r) => setTimeout(r, holdMs));
      yield ["result", { reply: tag }];
    } finally {
      preLock();
      log.push(`${stamp()} RELEASE ${tag}`);
    }
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const phases = () =>
  listActive().map((j) => `${j.job_id.slice(0, 8)}:${j.site_id}:${(j.status_line as { phase?: string }).phase ?? j.status}`);

let failures = 0;
function assert(cond: boolean, label: string) {
  log.push(`${stamp()} ${cond ? "PASS" : "FAIL"} ${label} :: ${phases().join(" | ")}`);
  if (!cond) failures++;
}

async function main() {
  // 1) same-site serializes, cross-site parallel (pool=2)
  await startJob({ siteId: "siteA", prompt: "a1", page: "/", makeGen: fakeGen("A1", 300) });
  await startJob({ siteId: "siteA", prompt: "a2", page: "/", makeGen: fakeGen("A2", 120) });
  await startJob({ siteId: "siteB", prompt: "b1", page: "/", makeGen: fakeGen("B1", 60) });
  assert(log.filter((l) => l.includes("ADMIT")).length === 2, "two admitted at once (pool=2)");
  assert(log.some((l) => l.includes("ADMIT A1")) && log.some((l) => l.includes("ADMIT B1")), "A1+B1 admitted, A2 queued");
  const firstStatuses = listActive().filter((j) => j.site_id === "siteA").map((j) => j.status);
  assert(firstStatuses.filter((s) => s === "running").length === 1, "executing same-site job reports running");
  assert(firstStatuses.filter((s) => s === "queued").length === 1, "waiting same-site job reports queued");

  await sleep(120); // B1 done -> slot free, but A2 blocked on site A lock
  assert(!log.some((l) => l.includes("ADMIT A2")), "A2 NOT admitted after B1 frees slot (site A lock held)");

  await sleep(200); // A1 done -> A2 admits and is still running
  assert(log.some((l) => l.includes("ADMIT A2")), "A2 admitted after A1 finished");
  assert(
    listActive("siteA").some((j) => j.status === "running" && (j.status_line as { phase?: string }).phase === "syncing"),
    "queued job becomes running on admission",
  );

  await sleep(150); // A2 done
  // 2) priority lane: fill pool with C1/D1, queue E(pri 0) then F(pri 10)
  await startJob({ siteId: "siteC", prompt: "c1", page: "/", makeGen: fakeGen("C1", 350) });
  await startJob({ siteId: "siteD", prompt: "d1", page: "/", makeGen: fakeGen("D1", 350) });
  await startJob({ siteId: "siteE", prompt: "e", page: "/", makeGen: fakeGen("E-low", 10), priority: 0 });
  await startJob({ siteId: "siteF", prompt: "f", page: "/", makeGen: fakeGen("F-high", 10), priority: 10 });
  await sleep(80);
  assert(!log.some((l) => l.includes("ADMIT E-low")) && !log.some((l) => l.includes("ADMIT F-high")), "pool full: E and F queued");
  await sleep(400); // C1 or D1 frees a slot
  const admitIdx = (tag: string) => log.findIndex((l) => l.includes(`ADMIT ${tag}`));
  assert(admitIdx("F-high") > 0 && admitIdx("E-low") > admitIdx("F-high"), "F-high (pri 10) admitted before E-low (pri 0)");

  // 3) cancel a still-queued job: reaped, never admitted
  await startJob({ siteId: "siteG", prompt: "g1", page: "/", makeGen: fakeGen("G1", 300) });
  const g2 = await startJob({ siteId: "siteG", prompt: "g2", page: "/", makeGen: fakeGen("G2-cancelled", 10) });
  cancelJob(g2.jobId);
  await sleep(60);
  assert(!log.some((l) => l.includes("ADMIT G2-cancelled")), "cancelled-queued job never admitted");
  assert(g2.status === "error", "cancelled job terminal");

  console.log(log.join("\n"));
  console.log(failures ? `\n${failures} FAILURES` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}
void main();
