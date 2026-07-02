# Contributing

Agent Keyboard is a personal project. I run it against my own websites, and it's open source because
there's no reason for it not to be — not because it's aiming to be a maintained product with a
roadmap. Set expectations accordingly:

- **Bug reports and issues are welcome.** If something is wrong or unclear — especially in the
  self-hosting path — open an issue. Concrete repro steps help.
- **PRs are considered best-effort.** Small, focused changes (a bug fix, a doc correction, a rough
  edge in setup) have the best odds. Large refactors or new features probably won't land; open an
  issue to talk first rather than writing a big PR on spec.
- **Forking is the intended path.** The natural way to make this yours is to fork it, point `SITES` at
  your own repos, and run your own server. See [SELF_HOSTING.md](./SELF_HOSTING.md). You don't need my
  permission and you don't need to upstream anything.
- **Only the owner can push here.** This is a single-owner repo by design — the whole product is built
  around one allowed email. Contributions come via issues and PRs from forks.

One thing that looks unusual but is normal here: **commits authored by `Agent Keyboard` are the
product working.** The bar edits this very repo and pushes to `main`, so agent-authored commits in the
history are expected, not a compromise.

If you do open a PR, match the surrounding style: no emojis, honest and direct, and keep changes
scoped to what you're actually fixing.
