# Noteback — install & CLI reference

The practical reference for installing Noteback and using the `noteback` CLI. For
the *why* and the architecture, see [`design.md`](design.md); for the runtime API
and canvas format, see [`../CONTRACTS.md`](../CONTRACTS.md).

There are two on-ramps and they are decoupled — you can use either on its own:

| On-ramp | What you get | Registry |
|---------|--------------|----------|
| **Agent skill** | An AI agent hands you docs that are *already* annotatable | **GitHub** serves the skill |
| **`wrap` CLI** | Turn any HTML into a feedback canvas yourself | **npm** serves the CLI |
| **Chrome extension** | Annotate any local `file://` / `localhost` page | **[Chrome Web Store](https://chromewebstore.google.com/detail/noteback/bgmcjepifnlgenbjlplaeapllkamcejc)** |

---

## As an agent skill

So an AI coding agent (Claude Code, Codex, OpenCode, …) writes a plan/spec/report
as HTML, wraps it, and you comment in the browser — then paste the Markdown back
to iterate. The skill itself lives in
[`../skills/noteback/SKILL.md`](../skills/noteback/SKILL.md).

Two install paths, because the skill and the CLI live in **two independent
registries** (see [Two registries, by design](#two-registries-by-design)):

```sh
# A) via the `skills` tool — pulls the skill straight from GitHub:
npx skills add alekkowalczyk/noteback          # into ./.claude/skills
npx skills add alekkowalczyk/noteback -g       # into ~/.claude/skills (global)
npx skills add alekkowalczyk/noteback --list   # preview what's in the repo, install nothing

# B) via the bundled installer — copies the skill out of the npm package:
npx noteback install-skill            # → ~/.agents/skills/noteback/ + ~/.claude/skills symlink
npx noteback install-skill --project  # → ./.agents/skills/noteback/ + ./.claude/skills symlink
npx noteback install-skill --dir <path>   # → a plain copy in a specific dir (no symlink)
```

`install-skill` mirrors `skills add`: it writes the skill's real files to the
**vendor-neutral `~/.agents/skills/` hub** — which **Codex** and **OpenCode** read
natively — and **symlinks** it into `~/.claude/skills/` so **Claude Code** (which
reads only there) picks it up too. One install, all three agents; re-running
updates in place. `--dir` is a plain-copy escape hatch (no hub, no symlink).

Restart your agent afterward so it discovers the skill. The skill then calls
`npx noteback wrap` itself, so the `wrap` CLI must be reachable on npm regardless
of how the skill was installed.

## The `wrap` CLI — born-annotatable docs

```sh
npx noteback wrap plan.html              # rewrite in place → plan.html IS the canvas
npx noteback wrap plan.html -o out.html  # keep the original, write a separate canvas
```

`wrap` reuses the same tested canvas builder as the extension's **Save… → HTML ·
with comments** export, so all three on-ramps produce the same embedded mode.
Re-wrapping an existing canvas is idempotent (the old runtime + comment state are
stripped before a fresh empty one is embedded).

## As a Chrome extension

Install from the **[Chrome Web Store](https://chromewebstore.google.com/detail/noteback/bgmcjepifnlgenbjlplaeapllkamcejc)**
(one click, auto-updates).

To annotate `file://` docs, open the extension's **Details** page and enable
**"Allow access to file URLs."** (`localhost` / `127.0.0.1` are opt-in — switch
them on from the extension popup; they're off by default.)

### From source (unpacked, for development)

1. Clone this repo.
2. Open `chrome://extensions`.
3. Enable **Developer mode** (top-right).
4. Click **Load unpacked** and select the repo root (the folder with
   `manifest.json`).

### Permissions (minimal by design)

`storage` (persist comments), `activeTab` + `scripting` (act on the current tab on
demand), `downloads` (export the canvas), and host access limited to `file:///*`,
`http://localhost/*`, `http://127.0.0.1/*`. No remote code, which also eases Web
Store review. See [`design.md` §4.3](design.md) for the rationale.

## Two registries, by design

`npx skills add owner/repo`
([vercel-labs/skills](https://github.com/vercel-labs/skills)) uses **GitHub** as
its registry — it clones this public repo and reads `skills/noteback/SKILL.md`
from the default branch. `npx noteback …` uses **npm** — it runs the published
`noteback` package's CLI. GitHub serves the *skill*; npm serves the *`wrap`
command*. They're decoupled, so either on-ramp works on its own.
