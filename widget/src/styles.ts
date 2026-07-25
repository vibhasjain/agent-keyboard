// One scoped stylesheet for the shadow root. `:host{all:initial}` wipes inherited
// host-page styles; every class is ak-prefixed. Tokens + orb/pill/ticker ported
// from halo/site/agent-keyboard-flight-prototype.html and halo/CLAUDE.md.

export const STYLES = `
:host{ all: initial; }
*,*::before,*::after{ box-sizing: border-box; }
button{
  -webkit-appearance:none; appearance:none;
  -webkit-tap-highlight-color:transparent;
  outline:none; font:inherit;
}
button:focus, button:focus-visible{ outline:none; }
button::-moz-focus-inner{ border:0; }

:host{
  --ak-bg:#0a0a0a; --ak-bg2:#111110; --ak-ink:#f5f1ea; --ak-ink2:#b8b2a7; --ak-ink3:#6f6a61;
  --ak-rule:#211f1c; --ak-amber:#ffb86b; --ak-amber2:#f9a26c; --ak-amber-deep:#c4651a;
  --ak-warm:#e7d3b8; --ak-violet:#b794f6; --ak-ok:#6dd396; --ak-err:#f97066;
  --ak-mono:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,monospace;
  --ak-serif:'Instrument Serif',Georgia,'Times New Roman',serif;
  --ak-sans:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,Roboto,sans-serif;
  --ak-kb:0px;
  --ak-fs-input:16px; /* anything smaller and iOS zooms the page on focus */
  --panel-open-dur:400ms; --panel-close-dur:350ms; --panel-ease:cubic-bezier(.22,1,.36,1);
  --panel-translate-y:100px; --panel-blur:2px;
}

/* ---- bottom zone (keyboard-avoiding) ---- */
.ak-zone, .ak-overlay{ font-family:var(--ak-mono); }
.ak-zone{
  width:100%;
  display:block;
  padding:0 14px calc(10px + env(safe-area-inset-bottom,0px)) 14px;
  font-family:var(--ak-mono);
  color:var(--ak-ink);
  touch-action:pan-y; /* no pinch-zoom / double-tap-zoom from the bar */
}
.ak-zone{ pointer-events:none; }
.ak-pill, .ak-composer, .ak-overlay, .ak-lightbox, .ak-mini{ pointer-events:auto; }
/* The corner box: whichever of the rectangle / streaming pill is showing, parked
   bottom-right. Nothing focusable lives down here any more — the composer and the
   auth forms are both in the transcript footer — so the zone never needs lifting
   above the keyboard; .ak-ov-foot does that with --ak-kb. */
.ak-bar{ display:flex; justify-content:flex-end; }
.ak-stash{ display:none; }

/* ---- the resting rectangle: ⌨️ + one line of status, parked bottom-right ---- */
.ak-mini{
  display:flex; align-items:center; gap:9px;
  margin-left:auto; margin-right:0;
  width:168px; height:44px; padding:0 11px;
  border-radius:10px; border:1px solid rgba(245,241,234,.13);
  background:rgba(9,9,11,.8); /* Menu++ sticky nav: bg-zinc-950/80 */
  box-shadow:0 7px 24px rgba(0,0,0,.28);
  backdrop-filter:blur(24px); /* Menu++ sticky nav: backdrop-blur-xl */
  -webkit-backdrop-filter:blur(24px);
  color:var(--ak-warm); cursor:pointer;
  animation:ak-pop .3s cubic-bezier(.2,.7,.2,1);
  transition:transform .16s ease, border-color .2s ease, color .2s ease;
}
.ak-mini.ak-mini-long{ width:206px; }
.ak-mini:hover{ transform:scale(1.03); }
.ak-mini:active{ transform:scale(.98); }
.ak-mini.done{ color:var(--ak-ok); border-color:rgba(109,211,150,.4); }
.ak-mini.error{ color:var(--ak-err); border-color:rgba(249,112,102,.4); }
.ak-mini-glyph{
  flex:none; font-size:15px; line-height:1;
  filter:drop-shadow(0 0 6px rgba(255,184,107,.5));
  animation:ak-breathe 3.4s ease-in-out infinite;
}
@keyframes ak-breathe{ 0%,100%{ transform:scale(1); } 50%{ transform:scale(1.09); } }
.ak-mini-copy{
  flex:1; min-width:0; text-align:left;
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  font-family:var(--ak-mono); font-size:11.5px; line-height:1; letter-spacing:.015em;
}
.ak-mini-arrow{ flex:none; color:var(--ak-amber); opacity:.75; }

/* ---- pill: the same corner box, swapped in while a job streams ---- */
.ak-pill{
  width:206px; height:44px; padding:0 11px; margin:0;
  border-radius:10px;
  display:flex; align-items:center;
  background:rgba(12,11,10,.96);
  border:1px solid #3d372e;
  box-shadow:0 7px 24px rgba(0,0,0,.36);
  backdrop-filter:blur(14px) saturate(140%);
  -webkit-backdrop-filter:blur(14px) saturate(140%);
  overflow:hidden; position:relative; cursor:pointer;
  animation:ak-pop .3s cubic-bezier(.2,.7,.2,1);
}
@keyframes ak-pop{ from{ opacity:0; transform:translateY(6px); } to{ opacity:1; transform:none; } }
.ak-pill.thinking{ border-color:rgba(183,148,246,.5); box-shadow:0 8px 30px rgba(149,113,233,.18); }

/* shimmer sweep on the streaming pill */
.ak-shimmer{
  position:absolute; inset:0; pointer-events:none;
  transform:translateX(-100%);
  background:linear-gradient(90deg, transparent, rgba(245,241,234,.05), transparent);
  animation:ak-shimmer 1.6s infinite;
}
@keyframes ak-shimmer{ 100%{ transform:translateX(100%); } }

/* ---- streaming row ---- */
.ak-stream{ display:flex; align-items:center; gap:8px; width:100%; min-width:0; }
.ak-spin{
  flex:none; width:16px; height:16px; border-radius:50%;
  border:2px solid var(--ak-ink3); border-top-color:var(--ak-amber);
  animation:ak-spin .7s linear infinite;
}
@keyframes ak-spin{ to{ transform:rotate(360deg); } }
.ak-timer{ flex:none; font-family:var(--ak-mono); font-size:10.5px; color:var(--ak-ink3); font-variant-numeric:tabular-nums; }
.ak-qbadge{ flex:none; font-family:var(--ak-mono); font-size:10.5px; color:var(--ak-ink3); }

/* ---- ticker (ported) ---- */
.ak-ticker{ position:relative; flex:1; min-width:0; height:16px; overflow:hidden; display:flex; align-items:center; }
.ak-line{
  position:absolute; left:0; right:0; height:100%;
  display:block; overflow-x:auto; overflow-y:hidden; white-space:nowrap;
  font-family:var(--ak-mono); font-size:10.5px; letter-spacing:.015em; line-height:16px;
  transform:translateY(0); opacity:1;
  transition:transform .6s cubic-bezier(.32,.08,.22,1), opacity .45s ease;
  scrollbar-width:none; -ms-overflow-style:none;
}
.ak-line::-webkit-scrollbar{ display:none; }
.ak-line.entering{ transform:translateY(115%); opacity:0; }
.ak-line.exiting{ transform:translateY(-115%); opacity:0; }
.ak-line.dim{ color:var(--ak-ink3); }
.ak-line.thinking{ color:var(--ak-violet); font-style:italic; }
.ak-line.tool{ color:var(--ak-amber); }
.ak-line.assistant{ color:var(--ak-warm); }

/* ---- login (Claude Code prompt sequence: "> email" / "> password") ---- */
.ak-login{ display:flex; flex-direction:column; width:100%; }
.ak-login.shake{ animation:ak-shake .4s; }
@keyframes ak-shake{ 0%,100%{ transform:translateX(0);} 20%,60%{ transform:translateX(-5px);} 40%,80%{ transform:translateX(5px);} }
.ak-lg-row{ display:flex; align-items:center; gap:8px; }
.ak-lg-mark{
  flex:none; width:13px; text-align:center; user-select:none;
  color:var(--ak-ink3); font-size:13px;
  transition:color .2s ease;
}
.ak-lg-row:focus-within .ak-lg-mark{ color:var(--ak-amber); }
.ak-login.error .ak-lg-mark{ color:var(--ak-err); }
.ak-lg-rule{ height:1px; background:var(--ak-rule); }
.ak-setpw-label{ font-family:var(--ak-mono); font-size:11.5px; line-height:1.4; color:var(--ak-ink2); padding:4px 0; }
.ak-login.error .ak-setpw-label{ color:var(--ak-err); }
.ak-login input{
  flex:1; min-width:0; border:none; outline:none; background:transparent;
  color:var(--ak-ink); font-family:var(--ak-mono); font-size:var(--ak-fs-input); line-height:20px;
  padding:8px 0; caret-color:var(--ak-amber);
}
.ak-login input::placeholder{ color:var(--ak-ink3); }
.ak-login.error input::placeholder{ color:var(--ak-err); } /* the failure message sits here */
.ak-login input:-webkit-autofill{
  -webkit-text-fill-color:var(--ak-ink);
  -webkit-box-shadow:0 0 0 1000px #0c0b0a inset;
  caret-color:var(--ak-amber);
}
.ak-lg-go{ flex:none; width:36px; height:36px; }
/* Signed out, this wrapper takes the composer's slot in the transcript footer, so
   it wears the composer's card chrome. */
.ak-auth-footer{
  width:100%; box-sizing:border-box;
  background:rgba(12,11,10,.96);
  border:1px solid #3d372e; border-radius:8px; padding:4px 10px;
}
.ak-ov-foot > .ak-auth-footer{ box-shadow:none; background:transparent; }

/* ---- composer (Claude Code terminal input box) ---- */
.ak-composer{
  background:rgba(12,11,10,.96);
  border:1px solid #3d372e;
  border-radius:8px; padding:4px 6px;
  display:flex; flex-direction:column; gap:4px;
  backdrop-filter:blur(14px) saturate(140%);
  -webkit-backdrop-filter:blur(14px) saturate(140%);
  box-shadow:0 6px 22px rgba(0,0,0,.5);
}
.ak-ov-foot > .ak-composer{ box-shadow:none; background:transparent; }
.ak-input-row{ display:flex; align-items:flex-end; gap:2px; }
.ak-ta-wrap{ position:relative; flex:1; min-width:0; display:flex; }
.ak-ta-wrap .ak-ta{ width:100%; padding-left:8px; }
.ak-ta{
  flex:1; min-width:0; border:none; outline:none; resize:none; background:transparent;
  display:block; box-sizing:border-box; height:36px; min-height:36px;
  color:var(--ak-ink); font-family:var(--ak-mono); font-size:var(--ak-fs-input); line-height:20px;
  max-height:88px; padding:8px 4px; overflow-y:auto;
}
.ak-ta::placeholder{ color:var(--ak-ink3); }
.ak-ta.ak-confirm::placeholder{ color:var(--ak-amber); opacity:1; } /* brief sign-in confirmation */
.ak-ta:disabled{ opacity:.6; }
.ak-icon-btn{
  flex:none; width:36px; height:36px; border-radius:50%; border:none; background:transparent;
  color:var(--ak-ink2); line-height:0; cursor:pointer; position:relative;
  display:flex; align-items:center; justify-content:center;
  transition:color .2s ease, background .2s ease;
}
.ak-icon-btn:hover{ color:var(--ak-amber); }
.ak-icon-btn:disabled{ opacity:.4; cursor:default; }
.ak-send{ color:var(--ak-amber); border-radius:8px; }
.ak-send:hover{ background:rgba(255,184,107,.1); }
.ak-send:disabled{ background:transparent; color:var(--ak-ink3); }

.ak-opt:focus-visible, .ak-menu-item:focus-visible{
  outline:1px solid rgba(255,184,107,.72); outline-offset:2px;
}

/* mic states */
.ak-mic.connecting{ color:var(--ak-amber); }
.ak-mic.live{ color:var(--ak-amber); }
.ak-mic.live::after{
  content:""; position:absolute; inset:4px; border-radius:50%;
  background:rgba(255,184,107,.35); animation:ak-ping 1.3s cubic-bezier(0,0,.2,1) infinite; z-index:-1;
}
.ak-mic .ak-spin{ width:15px; height:15px; }
@keyframes ak-ping{ 0%{ transform:scale(.7); opacity:.7; } 80%,100%{ transform:scale(1.9); opacity:0; } }
.ak-note{ font-family:var(--ak-mono); font-size:10px; color:var(--ak-ink3); padding:0 6px 2px; }
.ak-note.err{ color:var(--ak-err); }

/* ---- attachment chips ---- */
.ak-chips{ display:none; flex-wrap:wrap; gap:6px; padding:2px 4px 0; }
.ak-file{ display:none; }
.ak-chip{
  position:relative; width:44px; height:44px; border-radius:10px; overflow:hidden;
  border:1px solid var(--ak-rule); background:var(--ak-bg2); cursor:default;
}
.ak-chip.error{ border-color:var(--ak-err); cursor:pointer; }
.ak-chip.done{ border-color:rgba(109,211,150,.6); }
.ak-chip-img{ width:100%; height:100%; object-fit:cover; display:block; }
.ak-chip-file{
  position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center;
  gap:2px; padding:5px 4px; color:var(--ak-ink2);
}
.ak-chip-file svg{ color:var(--ak-amber); flex:0 0 auto; }
.ak-chip-ext{
  max-width:34px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  font-family:var(--ak-mono); font-size:9px; line-height:1; color:var(--ak-ink3);
}
.ak-chip-ring{
  position:absolute; inset:0; background:conic-gradient(rgba(255,184,107,.9) calc(var(--p,0)*1%), rgba(0,0,0,.45) 0);
  mask:radial-gradient(circle 22px at center, transparent 12px, #000 13px);
  -webkit-mask:radial-gradient(circle 22px at center, transparent 12px, #000 13px);
}
.ak-chip-ok{ position:absolute; right:2px; bottom:2px; width:15px; height:15px; border-radius:50%; background:var(--ak-ok); color:#04140b; font-size:10px; display:flex; align-items:center; justify-content:center; }
.ak-chip-retry{ position:absolute; inset:0; display:flex; align-items:center; justify-content:center; color:var(--ak-err); font-size:16px; background:rgba(0,0,0,.35); }
.ak-chip-x{
  position:absolute; top:1px; right:1px; width:16px; height:16px; border-radius:50%; border:none;
  background:rgba(0,0,0,.65); color:var(--ak-ink); font-size:9px; line-height:1; cursor:pointer;
  display:flex; align-items:center; justify-content:center;
}

/* ---- chat overlay (Claude Code terminal transcript) ---- */
/* Opening is now the only way in, so it gets a real transition: the panel slides
   up, unblurs and settles. --ak-dismiss-* are written by the pull-down gesture and
   ride the same two properties, so the drag and the animation never fight. */
.ak-overlay{
  position:fixed; inset:0; z-index:1; background:var(--ak-bg); color:var(--ak-ink);
  display:flex; flex-direction:column; height:100vh; height:100dvh;
  transform:translateY(var(--panel-translate-y)); opacity:0; filter:blur(var(--panel-blur));
  pointer-events:none; will-change:transform,opacity;
  transition:
    transform var(--panel-close-dur) var(--panel-ease),
    opacity var(--panel-close-dur) ease,
    filter var(--panel-close-dur) ease;
}
.ak-overlay[data-open="true"]{
  transform:translateY(var(--ak-dismiss-y,0px)); opacity:var(--ak-dismiss-opacity,1); filter:blur(0);
  pointer-events:auto;
  transition:
    transform var(--panel-open-dur) var(--panel-ease),
    opacity var(--panel-open-dur) ease,
    filter var(--panel-open-dur) ease;
}
.ak-overlay.ak-dragging{ transition:none !important; } /* track the finger, don't chase it */
.ak-ov-close, .ak-ov-settings{
  /* pinned to the VISIBLE top corners: --ak-vvt tracks how far iOS scrolled the
     visual viewport down when the keyboard opened. A semi-translucent dark disc
     keeps them legible over any transcript content underneath. */
  position:absolute; top:calc(8px + env(safe-area-inset-top,0px) + var(--ak-vvt, 0px)); z-index:2;
  width:34px; height:34px; border-radius:50%; border:1px solid rgba(255,255,255,.09);
  background:rgba(10,10,10,.55);
  -webkit-backdrop-filter:blur(8px); backdrop-filter:blur(8px);
  box-shadow:0 2px 10px rgba(0,0,0,.4);
  color:var(--ak-ink2); line-height:0; cursor:pointer;
  display:flex; align-items:center; justify-content:center;
}
.ak-ov-close{ right:10px; }
.ak-ov-settings{ left:10px; }
.ak-ov-close:hover, .ak-ov-settings:hover, .ak-ov-settings.on{ color:var(--ak-amber); background:rgba(10,10,10,.72); }

/* settings dropdown (top-left) */
.ak-menu{
  position:absolute; z-index:4;
  top:calc(48px + env(safe-area-inset-top,0px) + var(--ak-vvt, 0px)); left:10px;
  min-width:160px; padding:5px;
  background:rgba(12,11,10,.98); border:1px solid var(--ak-rule); border-radius:11px;
  box-shadow:0 10px 34px rgba(0,0,0,.55);
  -webkit-backdrop-filter:blur(14px); backdrop-filter:blur(14px);
  display:flex; flex-direction:column; gap:1px;
  animation:ak-pop .16s cubic-bezier(.2,.7,.2,1);
}
.ak-menu-id{
  font-family:var(--ak-mono); font-size:10.5px; color:var(--ak-ink3);
  padding:7px 11px 8px; margin-bottom:3px; border-bottom:1px solid var(--ak-rule);
  max-width:220px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
}
.ak-menu-item{
  position:relative; display:flex; align-items:center; gap:11px; width:100%;
  padding:9px 11px; border-radius:7px; border:none; background:none; cursor:pointer;
  font-family:var(--ak-mono); font-size:13px; color:var(--ak-ink2); text-align:left;
}
.ak-menu-item svg{ width:16px; height:16px; color:var(--ak-ink3); flex:none; }
.ak-menu-item:hover{ background:rgba(255,255,255,.05); color:var(--ak-ink); }
.ak-menu-item:hover svg{ color:var(--ak-amber); }
.ak-menu-item[data-tip]::after{
  content:attr(data-tip); position:absolute; left:calc(100% + 8px); top:50%;
  width:max-content; max-width:238px; padding:7px 9px; border-radius:7px;
  border:1px solid rgba(255,255,255,.09); background:rgba(12,11,10,.98);
  color:var(--ak-ink2); box-shadow:0 8px 26px rgba(0,0,0,.46);
  font-size:11px; line-height:1.35; white-space:normal; text-align:left;
  opacity:0; transform:translate(-4px,-50%); pointer-events:none;
  transition:opacity .14s ease, transform .14s ease; z-index:5;
}
.ak-menu-item[data-tip]::before{
  content:''; position:absolute; left:calc(100% + 3px); top:50%;
  width:8px; height:8px; background:rgba(12,11,10,.98);
  border-left:1px solid rgba(255,255,255,.09); border-bottom:1px solid rgba(255,255,255,.09);
  opacity:0; transform:translate(-4px,-50%) rotate(45deg); pointer-events:none;
  transition:opacity .14s ease, transform .14s ease; z-index:6;
}
.ak-menu-item[data-tip]:hover::after,
.ak-menu-item[data-tip]:focus-visible::after{ opacity:1; transform:translate(0,-50%); }
.ak-menu-item[data-tip]:hover::before,
.ak-menu-item[data-tip]:focus-visible::before{ opacity:1; transform:translate(0,-50%) rotate(45deg); }
.ak-menu-item:disabled{ cursor:default; color:rgba(184,178,167,.38); }
.ak-menu-item:disabled svg{ color:rgba(111,106,97,.38); }
.ak-menu-item:disabled:hover{ background:none; color:rgba(184,178,167,.38); }
.ak-menu-item:disabled:hover svg{ color:rgba(111,106,97,.38); }
.ak-menu-spin{ width:16px; height:16px; border-width:2px; }
.ak-ov-scroll{
  flex:1; overflow-y:auto; -webkit-overflow-scrolling:touch;
  padding:calc(20px + env(safe-area-inset-top,0px)) 18px 10px;
  scrollbar-width:none; -ms-overflow-style:none;
  touch-action:pan-y; overscroll-behavior:contain; /* never chain scroll to the page behind */
}
.ak-ov-scroll::-webkit-scrollbar{ display:none; width:0; height:0; }
.ak-overlay{ touch-action:pan-y; }
.ak-ov-list{ max-width:860px; margin:0 auto; }
.ak-ov-sentinel{ height:1px; }
.ak-ov-foot{ padding:6px 14px; padding-bottom:calc(10px + max(env(safe-area-inset-bottom,0px), var(--ak-kb))); max-width:888px; box-sizing:border-box; width:100%; margin:0 auto; }

/* transcript lines: marker column + body, no bubbles */
.ak-t{ display:flex; gap:9px; font-size:13px; line-height:1.6; margin:0 0 10px; word-wrap:break-word; overflow-wrap:anywhere; }
.ak-t-mark{ flex:none; width:13px; text-align:center; user-select:none; }
.ak-t-body{ flex:1; min-width:0; white-space:pre-wrap; }
.ak-t.user{ color:var(--ak-ink3); margin-top:18px; }
.ak-t.user .ak-t-mark{ color:var(--ak-ink3); }
.ak-t.asst{ color:var(--ak-ink); }
.ak-t.asst .ak-t-mark{ color:var(--ak-warm); }
.ak-t.asst .ak-t-body{ white-space:normal; }
.ak-t.error{ color:var(--ak-err); }
.ak-t.error .ak-t-mark{ color:var(--ak-err); }
.ak-t.tool{ color:var(--ak-ink2); margin-bottom:4px; }
.ak-t.tool .ak-t-mark{ color:var(--ak-ok); }
.ak-t.live{ color:var(--ak-amber); }
.ak-t.live .ak-t-body{ color:var(--ak-amber); }
.ak-t-star{ color:var(--ak-amber); animation:ak-star 1.2s ease-in-out infinite; }
@keyframes ak-star{ 0%,100%{ opacity:1; } 50%{ opacity:.35; } }
.ak-t .ak-t-body p{ margin:0 0 8px; }
.ak-t .ak-t-body p:last-child{ margin-bottom:0; }
.ak-t .ak-t-body ul, .ak-t .ak-t-body ol{ margin:0 0 8px; padding-left:18px; }
.ak-t .ak-t-body h1, .ak-t .ak-t-body h2, .ak-t .ak-t-body h3,
.ak-t .ak-t-body h4, .ak-t .ak-t-body h5, .ak-t .ak-t-body h6{
  font-weight:600; margin:12px 0 6px; line-height:1.35;
}
.ak-t .ak-t-body h1{ font-size:15px; }
.ak-t .ak-t-body h2{ font-size:14px; }
.ak-t .ak-t-body h3{ font-size:13.5px; }
.ak-t .ak-t-body h4, .ak-t .ak-t-body h5, .ak-t .ak-t-body h6{ font-size:13px; }
.ak-t .ak-t-body h1:first-child, .ak-t .ak-t-body h2:first-child, .ak-t .ak-t-body h3:first-child,
.ak-t .ak-t-body h4:first-child, .ak-t .ak-t-body h5:first-child, .ak-t .ak-t-body h6:first-child{ margin-top:0; }
.ak-t .ak-t-body blockquote{ margin:0 0 8px; padding-left:10px; border-left:2px solid var(--ak-rule); color:var(--ak-ink2); }
.ak-t .ak-t-body hr{ border:0; border-top:1px solid var(--ak-rule); margin:10px 0; }
.ak-t .ak-t-body code{ font-size:12px; background:var(--ak-bg2); padding:1px 5px; border-radius:4px; }
.ak-t .ak-t-body pre{ background:var(--ak-bg2); border:1px solid var(--ak-rule); border-radius:6px; padding:10px 12px; overflow-x:auto; margin:0 0 8px; }
.ak-t .ak-t-body pre code{ background:none; padding:0; }
.ak-t .ak-t-body a{ color:var(--ak-amber2); text-decoration:underline; text-underline-offset:2px; overflow-wrap:anywhere; }
.ak-t .ak-t-body a:hover{ color:var(--ak-amber); }
.ak-t.queued{ opacity:.5; }
.ak-t-thumbs{ display:flex; gap:6px; margin:2px 0 8px; }
.ak-t-thumbs img{ width:56px; height:56px; object-fit:cover; border-radius:6px; border:1px solid var(--ak-rule); display:block; cursor:zoom-in; }
.ak-lightbox{
  position:fixed; inset:0; z-index:5; background:rgba(0,0,0,.9);
  display:flex; align-items:center; justify-content:center; cursor:zoom-out;
  animation:ak-fade .15s ease;
  touch-action:none; overscroll-behavior:contain; /* tap-to-dismiss is the ONLY gesture */
}
.ak-lightbox img{ max-width:94vw; max-height:90vh; border-radius:8px; display:block; }
.ak-t-attach{ display:flex; align-items:center; gap:5px; color:var(--ak-ink3); font-size:11px; margin:1px 0 5px; }
.ak-divider{ color:var(--ak-ink3); font-size:11px; letter-spacing:.06em; margin:16px 0 16px 22px; }
.ak-empty{
  min-height:55vh;
  display:flex; align-items:center; justify-content:center;
  color:rgba(111,106,97,.42);
}
.ak-empty-mark{ width:28px; height:auto; display:block; }

/* history-loading ghost: dim bars with the shared .ak-shimmer sweep */
.ak-skel-row{
  position:relative; height:13px; margin:0 0 14px; border-radius:5px;
  background:var(--ak-bg2); overflow:hidden;
}
.ak-skel-row:first-child{ margin-top:4px; }

/* ---- live task checklist (agent TodoWrite) ---- */
.ak-todos{ display:flex; flex-direction:column; gap:3px; margin:0 0 10px 22px; }
.ak-todo{ display:flex; gap:8px; font-size:12.5px; line-height:1.5; }
.ak-todo-box{ flex:none; width:12px; text-align:center; user-select:none; }
.ak-todo-txt{ flex:1; min-width:0; }
.ak-todo.pending{ color:var(--ak-ink3); }
.ak-todo.pending .ak-todo-box{ color:var(--ak-ink3); }
.ak-todo.active{ color:var(--ak-ink); }
.ak-todo.active .ak-todo-box{ color:var(--ak-amber); }
.ak-todo.done{ color:var(--ak-ink2); }
.ak-todo.done .ak-todo-box{ color:var(--ak-ok); }

/* ---- running sub-agents (Agent tool): sticky "teammate alive" lines ---- */
.ak-agents{ display:flex; flex-direction:column; gap:3px; margin:0 0 8px 22px; }
.ak-agent{ display:flex; align-items:baseline; gap:8px; font-size:12.5px; line-height:1.5; }
.ak-agent-mark{ flex:none; width:12px; text-align:center; color:var(--ak-violet); animation:ak-star 1.2s ease-in-out infinite; }
.ak-agent-desc{ flex:1; min-width:0; color:var(--ak-ink); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ak-agent-time{ flex:none; font-size:10.5px; color:var(--ak-ink3); font-variant-numeric:tabular-nums; }

/* ---- tappable option buttons (\`\`\`options block in a reply) ---- */
.ak-opts{ display:flex; flex-wrap:wrap; gap:7px; margin:4px 0 8px; }
.ak-opt{
  font-family:var(--ak-mono); font-size:12.5px; line-height:1.2; color:var(--ak-ink);
  background:rgba(255,184,107,.06); border:1px solid #3d372e; border-radius:8px;
  padding:7px 12px; cursor:pointer;
  transition:color .16s ease, background .16s ease, border-color .16s ease;
}
.ak-opt:hover:not(:disabled){ color:var(--ak-amber); border-color:var(--ak-amber); background:rgba(255,184,107,.12); }
.ak-opt:active:not(:disabled){ transform:translateY(1px); }
/* An answered turn's options are spent: the one you took stays lit, the rest fade.
   Tapping any of them again in scrollback must not re-send. */
.ak-opt:disabled{ cursor:default; opacity:.42; }
.ak-opt.selected:disabled{
  opacity:1; color:var(--ak-amber);
  border-color:rgba(255,184,107,.68); background:rgba(255,184,107,.13);
}

@media (pointer:coarse){
  .ak-opt{ min-height:44px; padding:10px 12px; }
  .ak-menu-item{ min-height:44px; }
}

/* ---- reduced motion ---- */
@media (prefers-reduced-motion: reduce){
  .ak-shimmer, .ak-mic.live::after, .ak-mini-glyph{ animation:none !important; }
  .ak-line{ transition:opacity .2s ease !important; }
  /* Zero durations make the panel cut instead of slide, and setPanelOpen reads
     --panel-close-dur back, so it also stops deferring the display:none. */
  :host{ --panel-open-dur:0ms; --panel-close-dur:0ms; --panel-translate-y:0px; --panel-blur:0px; }
}
`
