// Demo-only styles. Two audiences:
//  · DEMO_STYLES — injected into the widget shadow root, alongside STYLES. Only
//    the login-mark mirror lives here: programmatic typing doesn't trigger
//    :focus-within, so .demo-focus stands in for it.
//  · MINISITE_STYLES — injected into the iframe's light DOM. The fake site behind
//    the bar: a real serif headline (so "make it bigger" visibly grows real
//    type), skeleton bars, a divider, and the deploy chip.

export const DEMO_STYLES = `
.ak-lg-row.demo-focus .ak-lg-mark{ color:var(--ak-amber); }
`

export const MINISITE_STYLES = `
:root{
  --bg:#0a0a0a; --ink:#f5f1ea; --ink2:#b8b2a7; --ink3:#6f6a61; --rule:#211f1c;
  --amber:#ffb86b; --ok:#6dd396;
  --serif:'Instrument Serif',Georgia,'Times New Roman',serif;
  --mono:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,monospace;
}
html,body{ margin:0; background:var(--bg); }
body{
  min-height:100vh; color:var(--ink);
  font-family:var(--mono);
  -webkit-font-smoothing:antialiased;
  overflow:hidden; /* the bar floats; the mini page never scrolls */
}
.demo-site{
  box-sizing:border-box; width:100%; max-width:560px;
  margin:0 auto; padding:40px 28px 150px;
}
.demo-headline{
  font-family:var(--serif); font-style:italic; font-weight:400;
  color:var(--ink); line-height:1.05; letter-spacing:.01em;
  font-size:30px; margin:0 0 22px;
  transition:font-size .55s cubic-bezier(.2,.7,.2,1), text-shadow .55s ease;
}
.demo-headline.grown{
  font-size:42px;
  animation:demo-glow 1.1s ease-out;
}
@keyframes demo-glow{
  0%{ text-shadow:0 0 0 rgba(255,184,107,0); }
  35%{ text-shadow:0 0 22px rgba(255,184,107,.55); }
  100%{ text-shadow:0 0 0 rgba(255,184,107,0); }
}
.demo-bar{ height:11px; border-radius:6px; background:var(--rule); margin:0 0 12px; }
.demo-bar.w1{ width:92%; }
.demo-bar.w2{ width:74%; }
.demo-rule{ height:1px; background:var(--rule); margin:26px 0 0; width:52px; }

/* deploy chip — mono, pinned top-right; pulses while deploying, greens on live */
.demo-chip{
  position:fixed; top:14px; right:14px;
  display:none; align-items:center; gap:7px;
  font-family:var(--mono); font-size:11px; letter-spacing:.02em;
  color:var(--ink2); background:rgba(12,11,10,.9);
  border:1px solid var(--rule); border-radius:999px; padding:5px 11px;
}
.demo-chip.show{ display:inline-flex; }
.demo-chip .dot{ width:7px; height:7px; border-radius:50%; background:var(--amber); }
.demo-chip.deploying .dot{ animation:demo-pulse 1.1s ease-in-out infinite; }
.demo-chip.live{ color:var(--ok); border-color:rgba(109,211,150,.5); }
.demo-chip.live .dot{ background:var(--ok); animation:none; }
@keyframes demo-pulse{ 0%,100%{ opacity:1; } 50%{ opacity:.25; } }

@media (prefers-reduced-motion: reduce){
  .demo-headline{ transition:none; }
  .demo-headline.grown{ animation:none; }
  .demo-chip.deploying .dot{ animation:none; }
}
`
