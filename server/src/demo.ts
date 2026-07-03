// The demo scene pages: tiny, open, static HTML that loads the demo bundle
// (dist/demo.js, baked into the image beside widget.js) with a scene id. The
// marketing site embeds these in iframes — because they ship in the same image
// as the widget, the demos always match the deployed product. Dummy data only:
// the demo bundle never talks to Supabase or GitHub, and every privileged
// server route still requires a real owner JWT.

export const DEMO_SCENES = ["ship", "photo", "voice", "expand", "login"] as const;
export type DemoScene = (typeof DEMO_SCENES)[number];

export function isDemoScene(id: string): id is DemoScene {
  return (DEMO_SCENES as readonly string[]).includes(id);
}

export function demoPage(scene: DemoScene): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Agent Keyboard demo — ${scene}</title>
<style>html,body{margin:0;padding:0;background:#0a0a0a;height:100%;overflow:hidden}</style>
</head>
<body>
<script src="/demo.js" data-scene="${scene}" defer></script>
</body>
</html>`;
}
