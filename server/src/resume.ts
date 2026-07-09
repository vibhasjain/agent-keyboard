// Auto-resume after a self-triggered Fly redeploy.
//
// When the agent pushes a change to its OWN repo (the site whose repo IS
// agent-keyboard), Fly rebuilds and rolls the machine — SIGKILLing the very job
// that pushed. Without this, that job is silently interrupted mid-task right when
// the deploy it was waiting on goes live. So: on shutdown we synchronously drop a
// per-site "pending-resume" marker (Fly's kill window is ~5s — no time for
// async); on the next boot, if we came up on a genuinely NEW image, we re-launch
// each still-running turn with a short continuation prompt, resuming its Claude
// session (--resume finds it because the marker file still exists).
//
// The whole feature is gated behind AK_AUTO_RESUME=1 (default OFF) and is fully
// defensive: every fs op is in try/catch and the boot call is .catch'd, so with
// the flag off — or if anything throws — boot and shutdown are unaffected.

import { mkdirSync, writeFileSync, readFileSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./checkouts.js";
import { SITES, getSite } from "./sites.js";
import {
  conversationIdFor,
  markerPathFor,
  runMessageJob,
  runStreamingSession,
  InputChannel,
} from "./claude.js";
import { startJob } from "./jobs.js";

const PENDING_DIR = join(DATA_DIR, "agent-keyboard", "pending-resume");

// The ONLY continuation text the resumed turn receives — a nudge, not a new task.
const CONTINUATION =
  "[Agent Keyboard] The server just redeployed with the change you pushed and " +
  "your session is back online. If your task was waiting on that deploy, " +
  "continue now and finish it (verify it's live if that was the plan). If you " +
  "were already done, reply with a one-line confirmation.";

/** Filesystem-safe marker filename component. */
function safe(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_");
}

interface ResumeInput {
  jobId: string;
  siteId: string;
  conversationId: string | null;
  sessionId: string | null;
  streaming: boolean;
  prompt: string;
  resumeCount: number;
}

/**
 * SYNCHRONOUS — called from shutdown(), where Fly gives ~5s before SIGKILL, so
 * there's no room for async fs. Writes one marker file per still-running job.
 * A no-op unless AK_AUTO_RESUME=1. Every write is wrapped so one failure never
 * blocks the shutdown path.
 */
export function writePendingResume(jobs: ResumeInput[]): void {
  if (process.env.AK_AUTO_RESUME !== "1") return;
  try {
    mkdirSync(PENDING_DIR, { recursive: true });
  } catch {
    /* best-effort */
  }
  for (const job of jobs) {
    try {
      const marker = {
        jobId: job.jobId,
        siteId: job.siteId,
        conversationId: job.conversationId,
        sessionId: job.sessionId,
        imageRef: process.env.FLY_IMAGE_REF ?? "",
        streaming: job.streaming,
        intent: String(job.prompt ?? "").slice(0, 200),
        resumeCount: job.resumeCount,
        at: new Date().toISOString(),
      };
      writeFileSync(join(PENDING_DIR, `${safe(job.siteId)}.json`), JSON.stringify(marker));
    } catch {
      /* one bad write must never block shutdown */
    }
  }
}

/**
 * Called once at boot (after the job sweep). For each site with a pending-resume
 * marker: consume it (rename BEFORE resuming — the infinite-loop guard), then run
 * a battery of checks; only if ALL pass do we re-launch the turn. Any failed
 * check just leaves the job interrupted (the honest default). A no-op unless
 * AK_AUTO_RESUME=1 and we're on Fly (FLY_IMAGE_REF set).
 */
export async function resumeAfterRedeploy(): Promise<void> {
  if (process.env.AK_AUTO_RESUME !== "1" || !process.env.FLY_IMAGE_REF) return;

  for (const site of SITES) {
    const path = join(PENDING_DIR, `${safe(site.id)}.json`);
    if (!existsSync(path)) continue;

    let marker: {
      jobId?: string;
      siteId?: string;
      conversationId?: string | null;
      sessionId?: string | null;
      imageRef?: string;
      streaming?: boolean;
      resumeCount?: number;
      at?: string;
    };
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    try {
      marker = JSON.parse(raw);
    } catch {
      // Corrupt marker — quarantine it so it can't re-fire, and move on.
      try {
        renameSync(path, `${path}.bad`);
      } catch {
        /* ignore */
      }
      continue;
    }

    // CONSUME BEFORE RESUMING: rename the marker before doing anything else, so a
    // resume that itself crashes on boot can never re-fire on the next boot.
    try {
      renameSync(path, `${path}.consumed`);
    } catch {
      /* ignore — validation below still runs; worst case we skip */
    }

    try {
      // (a) A REAL new image — resume ONLY if the digest changed (a genuine
      // redeploy). Same/absent image = a plain restart (OOM, host migration), not
      // our deploy → skip, so we never auto-resume on an ordinary bounce.
      if (!marker.imageRef || marker.imageRef === process.env.FLY_IMAGE_REF) continue;
      // (b) Fresh — don't resurrect a turn from a marker left days ago.
      if (!(Date.now() - Date.parse(marker.at ?? "") < 30 * 60_000)) continue;
      // (c) Loop cap.
      if (!((marker.resumeCount ?? 0) < 3)) continue;
      // (d) Site still allow-listed.
      const s = getSite(marker.siteId ?? "");
      if (!s) continue;
      // (e) Conversation not cleared / rotated since the marker was written.
      if ((await conversationIdFor(s.id)) !== marker.conversationId) continue;
      // (f) The Claude session file still exists, so --resume will find it.
      if (!marker.conversationId || !existsSync(markerPathFor(marker.conversationId))) continue;

      // All checks pass — launch a normal turn. The run auto-picks --resume
      // because the session marker file exists.
      const ac = new AbortController();
      const input = marker.streaming ? new InputChannel() : null;
      const gen = input
        ? runStreamingSession(s, { text: CONTINUATION, page: "/", attachmentPaths: [] }, input, ac.signal)
        : runMessageJob(s, { text: CONTINUATION, page: "/", attachmentPaths: [] }, ac.signal);
      await startJob({
        siteId: s.id,
        prompt: CONTINUATION,
        page: "/",
        gen,
        abort: () => ac.abort(),
        streaming: !!input,
        input,
        conversationId: marker.conversationId,
        sessionId: marker.sessionId ?? null,
        resumeCount: (marker.resumeCount ?? 0) + 1,
      });
    } catch (e) {
      console.error("[boot] auto-resume launch failed", e);
    }
  }
}
