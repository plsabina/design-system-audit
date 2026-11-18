# design-system-audit

Two checks that catch styling which has drifted away from a design token system:
one for code, one for Figma. They started life in a production design system
and were pulled out here so they can be dropped into any project.

## Why I built this

I built these for a product I was designing and building, where the design system
was the part I most wanted to keep honest. Tokens in Figma and tokens in code only
help if people use them, and in practice they drift: a hex typed by eye, a shadow
with its own rgba, a padding nudged to 10px. None of it is wrong on its own, and no
reviewer catches all of it.

So I made the system check itself. The code audit runs on every pull request and
names the token you probably meant. The Figma script does the same for the design
file, so drift gets caught on both sides of the handoff.

When I turned the audit on, the app already had problems in it. If the check had
failed every pull request until all of them were fixed, it would have blocked
everyone's work on day one. So it starts from a baseline: it records what's
already there and only fails on new problems, so the count can only go down.
Eight days after it landed, the app had no raw colors left.

Exceptions are allowed, but you have to write down why, on the line itself. That
turns a quiet workaround into a decision someone can read in review.

## Code: `audit.mjs`

A single Node script, no dependencies. It scans your source for:

| Rule | What it catches |
| --- | --- |
| `raw-color` | A hex or `rgb()` literal. Each is classed as **exact** (same as a token, use `var(--x)`), **near** (within a perceptual hair, OKLab ΔE under 0.02, almost always a token typed by eye), **off** (not in the system) or **translucent** (an alpha literal that should be a token at a set strength) |
| `off-strength` | `color-mix(in srgb, var(--ink) 9%, transparent)` where 9% isn't one of that token's set strengths |
| `off-grid` | A padding, margin or gap px value in CSS that isn't on the spacing grid |
| `token-redefined` | A token's custom property assigned outside the token file, which quietly forks the source of truth |

### Setup

Copy `design-audit.config.example.json` to the root of your project as
`design-audit.config.json` and edit it. Paths are relative to that file.

| Key | Meaning |
| --- | --- |
| `tokens` | Where the tokens live. Either a CSS file of custom properties (`--ink: #1a1a1a;`) or a flat JSON list, `{ "tokens": [{ "cssVar", "type": "color", "value": { "hex" } }] }` |
| `scan` | Folders to scan. Default `["src"]` |
| `extensions` | File types to scan. Default css, jsx, tsx, js, ts |
| `baseline` | Where the baseline is written. Default `design-audit-baseline.json` |
| `grid` | Spacing grid in px. Default 4 |
| `strengths` | Allowed see-through strengths per token, e.g. `{ "--ink": [4, 8, 15] }` |
| `secondary` | Optional regex of files to report separately (admin, internal tools, galleries) so they don't drown out the product UI |
| `tokensHint` | Optional: what to tell people to edit instead of redefining a token |

### Running it

```
node audit.mjs --update-baseline   # once, to accept what's there today
node audit.mjs                     # fails (exit 1) only on anything new
node audit.mjs --report            # clusters of findings, never fails
node audit.mjs --json              # every finding with file and line
```

Bun works in place of Node. Pass `--config <path>` to use a config elsewhere.

**The baseline is the point.** It freezes existing debt per file and value, without
line numbers, so unrelated edits don't churn it. A check only fails when a file has
*more* of something than the baseline allows: debt gets paid down on purpose, never
added to. When counts drop, the next run tells you to re-run `--update-baseline` to
lock the improvement in.

**Exceptions are argued where they live.** Put `/* design-audit: allow <why> */` on
the line, or `design-audit: allow-file <why>` once at the top of a file. The reason
is required.

Comments, `mask` declarations and things like `href="#top"` in JS are ignored.

### In CI

On GitHub Actions each new violation becomes an annotation on that line of the PR diff:

```yaml
- run: node audit.mjs
```

## Figma: `figma/audit.plugin.js`

A read-only Figma Plugin API script, the design-side twin. On one page it lists:

| Kind | What it catches |
| --- | --- |
| `raw-color` | A solid fill, stroke or shadow not bound to a variable or style |
| `no-text-style` | A text layer with no text style |
| `style-override` | A text layer whose font, size, line height or spacing differs from its style |
| `detached` | A frame that used to be a component instance |
| `broken` | An instance whose main component is gone |
| `missing-font` | A font Figma can't load |

Inside instances only overridden properties count, so a problem in a main component
is reported once, not once per instance. It also returns a structural fingerprint for
every main component, so diffing two runs shows what was added, changed or removed.

Set `PAGE` at the top (or leave it empty for the current page), `LOCAL_FONTS` for
fonts designers have locally that Figma can't load, and `EXEMPT` for layers whose
colors are content rather than tokens. Then run it through an agent's `use_figma`
tool, or paste it into a development plugin wrapped in an async function.
