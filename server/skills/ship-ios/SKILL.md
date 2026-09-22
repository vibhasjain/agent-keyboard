---
name: ship-ios
description: Ship a TestFlight build of the Vibes Instinct iOS app by starting an Xcode Cloud run from the current main. Use when the owner asks to ship / build / push an iOS build, get a change onto their phone, or send something to TestFlight. Only meaningful for the agent-keyboard-ios repo.
---

# ship-ios

You cannot run Xcode — you are a Linux container on Fly. What you *can* do is
ask Xcode Cloud to build `main` and send the result to TestFlight, then watch it.

## Before you start a build

**Your commit must already be on `main`.** Xcode Cloud clones the repo; it
cannot see your working tree. Push first, confirm the push landed, then start
the run.

**Small changes only.** A build takes ~10-15 minutes and lands on the owner's
phone, replacing whatever is there. Anything you cannot reason about from the
diff alone — a new capability, a permission prompt, a change to how the app
starts up — is worth saying "this needs a build from the Mac" instead. The
owner can always ask for it anyway.

## Why the guard rail exists

Build 64 (2026-09-21) shipped from Xcode Cloud with an empty `WA_API_TOKEN`,
because `Secrets.xcconfig` is gitignored and a previous agent "fixed" the
missing-file build error by committing an empty one. It compiled, it uploaded,
it passed processing, and it opened on the owner's phone as a black screen —
every bridge call was a 401.

So `ci_scripts/ci_post_clone.sh` now **refuses to build** when `WA_API_TOKEN`
is unset, rather than producing a working-looking app that cannot talk to
wa-bridge. If a run fails there, the fix is the workflow's secret environment
variable in App Store Connect — **never** a token committed to the repo. Say
so and stop; do not work around it.

Cloud builds number themselves `1000 + CI_BUILD_NUMBER`, clear of the Mac's
range, so they can never collide with a build the owner made locally. Do not
edit `CURRENT_PROJECT_VERSION` for a cloud build.

## Credentials

App Store Connect API key, as Fly secrets on this app:

| Secret | What |
|---|---|
| `ASC_KEY_ID` | key id |
| `ASC_ISSUER_ID` | issuer id |
| `ASC_PRIVATE_KEY` | the .p8 contents |

If any is missing, tell the owner which one — do not guess or invent a key.

## Constants

```
workflow     F4B6D896-2EA2-4107-9A00-74DCA99A8A86   (AgentKeyboard "Default")
main branch  52b4a048-42fb-4a95-bb9d-9b3b3a413711   (scmGitReference)
app id       6788202668
```

The workflow is **manual-trigger only** — pushing to `main` deliberately does
not build. That is a safety property, not a misconfiguration: leave it alone.

## Mint a token

```python
import jwt, os, time
now = int(time.time())
tok = jwt.encode(
    {"iss": os.environ["ASC_ISSUER_ID"], "iat": now, "exp": now + 1200,
     "aud": "appstoreconnect-v1"},
    os.environ["ASC_PRIVATE_KEY"], algorithm="ES256",
    headers={"kid": os.environ["ASC_KEY_ID"]},
)
```

## Start the run

```bash
curl -X POST "https://api.appstoreconnect.apple.com/v1/ciBuildRuns" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"data":{"type":"ciBuildRuns","relationships":{
        "workflow":{"data":{"type":"ciWorkflows","id":"F4B6D896-2EA2-4107-9A00-74DCA99A8A86"}},
        "sourceBranchOrTag":{"data":{"type":"scmGitReferences","id":"52b4a048-42fb-4a95-bb9d-9b3b3a413711"}}}}}'
```

The response carries the run id.

## Watch it

```bash
curl -s "https://api.appstoreconnect.apple.com/v1/ciBuildRuns/<run_id>" \
  -H "Authorization: Bearer $TOKEN" | jq '.data.attributes | {executionProgress, completionStatus, number}'
```

`executionProgress` goes `PENDING` → `RUNNING` → `COMPLETE`; then
`completionStatus` is `SUCCEEDED`, `FAILED`, `ERRORED`, or `CANCELED`. Poll
every ~60s. A build is roughly 10-15 minutes, so do not poll tightly and do not
promise a time.

On `FAILED`, get the reason before reporting — the issues endpoint is the
fastest read:

```bash
curl -s "https://api.appstoreconnect.apple.com/v1/ciBuildRuns/<run_id>/actions" -H "Authorization: Bearer $TOKEN"
curl -s "https://api.appstoreconnect.apple.com/v1/ciBuildActions/<action_id>/issues" -H "Authorization: Bearer $TOKEN"
```

## Confirm it actually reached TestFlight

`SUCCEEDED` means the archive built, not that the owner can install it. Check:

```bash
curl -s "https://api.appstoreconnect.apple.com/v1/builds?filter%5Bapp%5D=6788202668&sort=-uploadedDate&limit=1" \
  -H "Authorization: Bearer $TOKEN" | jq '.data[0].attributes | {version, processingState}'
```

Report the build number only once `processingState` is `VALID`. The "Internal"
group has `hasAccessToAllBuilds: true`, so it distributes with no further step.

## What to tell the owner

The build number and that it is installable — "build 1003 is on TestFlight".
Not "the build succeeded", which they cannot act on.
