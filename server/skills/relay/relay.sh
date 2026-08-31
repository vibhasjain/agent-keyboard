#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf '%s\n' \
    'Usage:' \
    '  relay.sh <handle[:/path]> <message> [--from <my-handle>] [--reply-to <handle>] [--wait] [--timeout <sec>] [--dry-run]' \
    '  relay.sh --jobs <handle[:/path]> [--dry-run]' >&2
}

die() {
  printf 'relay: %s\n' "$*" >&2
  exit 1
}

MODE="send"
WAIT=0
DRY_RUN=0
TIMEOUT=900
TIMEOUT_SET=0
FROM=""
REPLY_TO=""
MESSAGE=""

if [[ $# -eq 0 ]]; then
  usage
  exit 1
fi
if [[ "$1" == "-h" || "$1" == "--help" ]]; then
  usage
  exit 0
fi

if [[ "$1" == "--jobs" ]]; then
  MODE="jobs"
  shift
  [[ $# -ge 1 ]] || die "--jobs requires a handle"
  TARGET_SPEC="$1"
  shift
else
  [[ $# -ge 2 ]] || { usage; exit 1; }
  TARGET_SPEC="$1"
  MESSAGE="$2"
  shift 2
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --from)
      [[ "$MODE" == "send" ]] || die "--from is only valid when sending a message"
      [[ $# -ge 2 ]] || die "--from requires a handle"
      FROM="$2"
      shift 2
      ;;
    --reply-to)
      [[ "$MODE" == "send" ]] || die "--reply-to is only valid when sending a message"
      [[ $# -ge 2 ]] || die "--reply-to requires a handle"
      REPLY_TO="$2"
      shift 2
      ;;
    --wait)
      [[ "$MODE" == "send" ]] || die "--wait is only valid when sending a message"
      WAIT=1
      shift
      ;;
    --timeout)
      [[ "$MODE" == "send" ]] || die "--timeout is only valid when sending a message"
      [[ $# -ge 2 ]] || die "--timeout requires a positive number of seconds"
      [[ "$2" =~ ^[1-9][0-9]*$ ]] || die "--timeout requires a positive number of seconds"
      TIMEOUT="$2"
      TIMEOUT_SET=1
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1"
      ;;
  esac
done

[[ "$MODE" == "jobs" || -n "$MESSAGE" ]] || die "message must not be empty"
[[ "$WAIT" -eq 1 || "$TIMEOUT_SET" -eq 0 ]] || die "--timeout requires --wait"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HANDLES_FILE="$SCRIPT_DIR/handles.json"
[[ -f "$HANDLES_FILE" ]] || die "handles registry not found at $HANDLES_FILE"

RESOLVED="$({
  node --input-type=module - "$HANDLES_FILE" "$TARGET_SPEC" <<'NODE'
import { readFileSync } from "node:fs";

const [file, spec] = process.argv.slice(2);
const fail = (message) => {
  console.error(`relay: ${message}`);
  process.exit(1);
};

let registry;
try {
  registry = JSON.parse(readFileSync(file, "utf8"));
} catch (error) {
  fail(`cannot read handles registry: ${error instanceof Error ? error.message : String(error)}`);
}

const match = /^([a-z0-9-]+)(?::(\/.*))?$/.exec(spec);
if (!match) fail(`invalid target "${spec}" (expected handle or handle:/path)`);
const [, handle, pageOverride] = match;
const target = registry.handles?.[handle];
if (!target || typeof target !== "object") fail(`unknown handle: ${handle}`);
if (typeof target.instance !== "string" || typeof target.site !== "string") {
  fail(`handle "${handle}" has an invalid registry entry`);
}
const instance = registry.instances?.[target.instance];
if (!instance || typeof instance.app !== "string" || typeof instance.url !== "string") {
  fail(`handle "${handle}" refers to an unknown instance`);
}
if (pageOverride !== undefined && target.pageScoped !== true) {
  fail(`handle "${handle}" is not page-scoped`);
}
const page = pageOverride ?? (typeof target.page === "string" ? target.page : "/");
if (!page.startsWith("/")) fail(`handle "${handle}" has an invalid default page`);

process.stdout.write([
  handle,
  target.instance,
  target.site,
  instance.app,
  instance.url,
  page,
  String(target.pageScoped === true),
  String(target.guest === true),
].join("\t"));
NODE
} )"

IFS=$'\t' read -r TARGET_HANDLE INSTANCE SITE TARGET_APP INSTANCE_URL PAGE PAGE_SCOPED TARGET_GUEST <<< "$RESOLVED"
[[ -n "$TARGET_HANDLE" && -n "$SITE" && -n "$TARGET_APP" && -n "$INSTANCE_URL" ]] || die "invalid resolved handle"

[[ -n "${FLY_APP_NAME:-}" ]] || die "FLY_APP_NAME is required to choose same-instance or peer routing"
if [[ "$TARGET_APP" == "$FLY_APP_NAME" ]]; then
  [[ -n "${PORT:-}" ]] || die "PORT is required for same-instance relay"
  [[ -n "${AK_INTERNAL_SECRET:-}" ]] || die "AK_INTERNAL_SECRET is required for same-instance relay"
  BASE="http://127.0.0.1:$PORT"
  AUTH_HEADER_NAME="x-ak-internal"
  AUTH_SECRET="$AK_INTERNAL_SECRET"
else
  [[ -n "${AK_RELAY_SECRET:-}" ]] || die "AK_RELAY_SECRET is required for cross-instance relay to $TARGET_APP"
  BASE="${INSTANCE_URL%/}"
  AUTH_HEADER_NAME="x-ak-relay"
  AUTH_SECRET="$AK_RELAY_SECRET"
fi
AUTH_HEADER="$AUTH_HEADER_NAME: $AUTH_SECRET"

encode_component() {
  node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$1"
}

ENCODED_SITE="$(encode_component "$SITE")"
if [[ "$MODE" == "jobs" ]]; then
  URL="$BASE/jobs?siteId=$ENCODED_SITE"
  if [[ "$PAGE_SCOPED" == "true" ]]; then
    URL="$URL&page=$(encode_component "$PAGE")"
  fi
  METHOD="GET"
  BODY=""
else
  URL="$BASE/sites/$ENCODED_SITE/messages"
  METHOD="POST"
  BODY="$({
    node --input-type=module - "$HANDLES_FILE" "$MESSAGE" "$PAGE" "$FROM" "$REPLY_TO" "$TARGET_HANDLE" "$TARGET_GUEST" <<'NODE'
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const [file, message, page, from, replyTo, targetHandle, targetGuest] = process.argv.slice(2);
const fail = (text) => {
  console.error(`relay: ${text}`);
  process.exit(1);
};
const registry = JSON.parse(readFileSync(file, "utf8"));
const handles = registry.handles ?? {};

if (from && !handles[from]) fail(`unknown --from handle: ${from}`);
if (replyTo) {
  const replyTarget = handles[replyTo];
  if (!replyTarget) fail(`unknown --reply-to handle: ${replyTo}`);
  if (replyTarget.guest === true) fail(`guest handle "${replyTo}" cannot be a --reply-to target`);
  if (targetGuest === "true") {
    fail(`guest handle "${targetHandle}" cannot run callbacks; use --wait or --jobs instead`);
  }
}

let text = from ? `[relay from ${from}] ${message}` : message;
if (replyTo) {
  text += `\n\nWhen this task is fully done, report back by running: bash /data/.claude/skills/relay/relay.sh ${replyTo} "[relay:done ${targetHandle}] <one-line summary of what you did>" — do not relay onward to anyone else unless this message explicitly asks.`;
}
process.stdout.write(JSON.stringify({ text, page, idemKey: randomUUID() }));
NODE
  } )"
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  printf 'method: %s\n' "$METHOD"
  printf 'url: %s\n' "$URL"
  printf 'headers:\n  %s: ***\n' "$AUTH_HEADER_NAME"
  if [[ "$METHOD" == "POST" ]]; then
    printf '  Content-Type: application/json\n'
    printf 'body: %s\n' "$BODY"
  else
    printf 'body: (none)\n'
  fi
  exit 0
fi

if [[ "$MODE" == "jobs" ]]; then
  curl -sS --fail-with-body -H "$AUTH_HEADER" "$URL"
  printf '\n'
  exit 0
fi

read -r -d '' SSE_PARSER <<'NODE' || true
const desired = process.argv[1];
let event = "";
let data = [];
let buffer = "";
let raw = "";
let matched = false;

const fail = (message) => {
  console.error(`relay: ${message}`);
  process.exit(1);
};

const finishFrame = () => {
  if (!event) {
    data = [];
    return;
  }
  const json = data.join("\n");
  const wanted = desired === "job" ? event === "job" : event === "result" || event === "error";
  if (wanted) {
    let payload;
    try {
      payload = JSON.parse(json);
    } catch {
      fail(`invalid JSON in ${event} frame`);
    }
    if (desired === "job") {
      if (!payload || typeof payload.job_id !== "string" || !payload.job_id) {
        fail("job frame did not include job_id");
      }
      process.stdout.write(`${payload.job_id}\n`);
    } else {
      process.stdout.write(`${json}\n`);
    }
    matched = true;
    process.exit(0);
  }
  event = "";
  data = [];
};

const consumeLine = (input) => {
  const line = input.endsWith("\r") ? input.slice(0, -1) : input;
  if (line === "") {
    finishFrame();
  } else if (line.startsWith(":")) {
    return;
  } else if (line.startsWith("event:")) {
    event = line.slice(6).trim();
  } else if (line.startsWith("data:")) {
    const value = line.slice(5);
    data.push(value.startsWith(" ") ? value.slice(1) : value);
  }
};

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  if (raw.length < 2000) raw += chunk.slice(0, 2000 - raw.length);
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) !== -1) {
    consumeLine(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
  }
});
process.stdin.on("end", () => {
  if (matched) return;
  if (buffer) consumeLine(buffer);
  finishFrame();
  const detail = raw.trim().replace(/\s+/g, " ").slice(0, 500);
  const target = desired === "job" ? "job" : "result or error";
  fail(`response ended before a ${target} frame${detail ? `: ${detail}` : ""}`);
});
process.stdin.on("error", (error) => fail(`could not read SSE stream: ${error.message}`));
NODE

CURL_ARGS=(
  -sS -N --fail-with-body
  -X POST "$URL"
  -H "$AUTH_HEADER"
  -H "Content-Type: application/json"
  --data "$BODY"
)
if [[ "$WAIT" -eq 1 ]]; then
  CURL_ARGS+=(--max-time "$TIMEOUT")
fi

RELAY_TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ak-relay.XXXXXX")"
RELAY_CURL_PID=""
cleanup_stream() {
  if [[ -n "${RELAY_CURL_PID:-}" ]]; then
    kill "$RELAY_CURL_PID" 2>/dev/null || true
    wait "$RELAY_CURL_PID" 2>/dev/null || true
  fi
  if [[ -n "${RELAY_TMP_DIR:-}" ]]; then
    rm -f "$RELAY_TMP_DIR/stream" "$RELAY_TMP_DIR/curl.err"
    rmdir "$RELAY_TMP_DIR" 2>/dev/null || true
  fi
}
trap cleanup_stream EXIT INT TERM

mkfifo "$RELAY_TMP_DIR/stream"
curl "${CURL_ARGS[@]}" >"$RELAY_TMP_DIR/stream" 2>"$RELAY_TMP_DIR/curl.err" &
RELAY_CURL_PID=$!

set +e
if [[ "$WAIT" -eq 1 ]]; then
  node -e "$SSE_PARSER" terminal <"$RELAY_TMP_DIR/stream"
else
  node -e "$SSE_PARSER" job <"$RELAY_TMP_DIR/stream"
fi
PARSER_STATUS=$?
set -e

kill "$RELAY_CURL_PID" 2>/dev/null || true
CURL_STATUS=0
if wait "$RELAY_CURL_PID"; then
  CURL_STATUS=0
else
  CURL_STATUS=$?
fi
RELAY_CURL_PID=""

if [[ "$PARSER_STATUS" -ne 0 ]]; then
  if [[ -s "$RELAY_TMP_DIR/curl.err" ]]; then
    sed -n '1,20p' "$RELAY_TMP_DIR/curl.err" >&2
  elif [[ "$CURL_STATUS" -ne 0 ]]; then
    printf 'relay: curl exited with status %s\n' "$CURL_STATUS" >&2
  fi
  exit "$PARSER_STATUS"
fi

cleanup_stream
RELAY_TMP_DIR=""
trap - EXIT INT TERM
