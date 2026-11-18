// Design audit: finds styling that bypasses a design token system.
//
//   node audit.mjs                    report + fail (exit 1) on anything new
//   node audit.mjs --report           full report, never fails
//   node audit.mjs --update-baseline  accept the current state as the baseline
//   node audit.mjs --json             every finding with file and line
//   node audit.mjs --config <path>    use a config other than ./design-audit.config.json
//
// Paths, tokens, strengths and the grid come from the config; see README.md.
//
// What it flags:
//   raw-color      a hex/rgb()/rgba() literal, classified against the tokens:
//                    exact  → same value as a token; use var(--x)
//                    near   → within a perceptual hair (OKLab ΔE < 0.02) of one; almost
//                             always drift, a token typed by eye
//                    off    → not in the system at all; promote it or drop it
//                    translucent → an rgba()/#rrggbbaa literal; write it as a token at a
//                             strength instead: color-mix(in srgb, var(--ink) 8%, transparent)
//   off-strength   a color-mix() of --ink or --white at a strength outside the set ones
//   off-grid       a padding/margin/gap px value in CSS that isn't on the spacing grid
//   token-redefined  a token's custom property assigned outside the token file, which
//                    silently forks the source of truth
//
// The baseline freezes what existed when the audit landed, per file and value, without
// line numbers, so unrelated edits don't churn it. A check fails only when a file has
// MORE of something than the baseline allows: the debt is paid down deliberately,
// never added to.
import fs from "node:fs/promises"
import path from "node:path"

const argAfter = flag => {
  const i = process.argv.indexOf(flag)
  return i === -1 ? null : process.argv[i + 1]
}
const CONFIG = path.resolve(argAfter("--config") ?? "design-audit.config.json")
const config = JSON.parse(
  await fs.readFile(CONFIG, "utf8").catch(() => {
    console.error(`No config at ${CONFIG}. Copy design-audit.config.example.json and edit it.`)
    process.exit(2)
  })
)
// Everything in the config is relative to the config file's folder (the repo root).
const REPO = path.dirname(CONFIG)
const SCAN = config.scan ?? ["src"]
const EXT = new RegExp(`\\.(${(config.extensions ?? ["css", "jsx", "tsx", "js", "ts"]).join("|")})$`)
const BASELINE = path.resolve(REPO, config.baseline ?? "design-audit-baseline.json")
const TOKENS = path.resolve(REPO, config.tokens)
const GRID = config.grid ?? 4
// See-through colors come in a few set strengths, e.g. { "--ink": [4, 8, 15] }. Tokens
// not listed here, mixed with transparent, are left to review.
const STRENGTHS = config.strengths ?? {}
// Files matching this are reported apart from the product UI (internal tools, galleries),
// so a user-facing regression doesn't hide inside tooling noise.
const SECONDARY = config.secondary ? new RegExp(config.secondary) : null
const TOKENS_HINT = config.tokensHint ?? path.relative(REPO, TOKENS)
const mode =
  process.argv.includes("--update-baseline") ? "update"
  : process.argv.includes("--report") ? "report"
  : "check"

// Tokens come from either a flat JSON list ({ tokens: [{ cssVar, type, value: { hex },
// aliasOf? }] }) or a plain CSS file of custom properties, where any `--name: <color>`
// is a color token and every other `--name:` still counts as a token for redefinitions.
async function loadTokens(file) {
  const src = await fs.readFile(file, "utf8")
  if (file.endsWith(".json")) {
    const all = JSON.parse(src).tokens
    return {
      colors: all
        .filter(t => t.type === "color" && !t.aliasOf)
        .map(t => ({ cssVar: t.cssVar, hex: t.value.hex, rgb: parse(t.value.hex) })),
      vars: new Set(all.map(t => t.cssVar))
    }
  }
  const colors = []
  const vars = new Set()
  for (const m of src.matchAll(/(--[\w-]+)\s*:\s*([^;}]+)/g)) {
    vars.add(m[1])
    const rgb = parse(m[2].trim())
    if (rgb && rgb.a === 1) colors.push({ cssVar: m[1], hex: hex(rgb), rgb })
  }
  return { colors, vars }
}
const { colors: colorTokens, vars: tokenVars } = await loadTokens(TOKENS)
if (!colorTokens.length) {
  console.error(`No color tokens found in ${TOKENS}.`)
  process.exit(2)
}

function parse(lit) {
  lit = lit.toLowerCase()
  let m = lit.match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/)
  if (m) {
    let h = m[1]
    if (h.length === 3) h = [...h].map(c => c + c).join("")
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1
    }
  }
  m = lit.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/)
  if (m) {
    const a =
      m[4] === undefined ? 1
      : m[4].endsWith("%") ? parseFloat(m[4]) / 100
      : parseFloat(m[4])
    return { r: +m[1], g: +m[2], b: +m[3], a }
  }
  return null
}
function hex({ r, g, b }) {
  return "#" + [r, g, b].map(x => Math.round(x).toString(16).padStart(2, "0")).join("")
}

// OKLab ΔE: perceptual distance, so "near" means "looks the same", not "close in hex".
function oklab({ r, g, b }) {
  const lin = c => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  const [R, G, B] = [lin(r), lin(g), lin(b)]
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B)
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B)
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  ]
}
const dE = (a, b) => Math.hypot(...oklab(a).map((v, i) => v - oklab(b)[i]))

function classify(rgb) {
  // Translucent literals (shadows, scrims) are compared on their base color but never
  // called "exact": a token can't express the alpha, so the fix is a decision.
  let best = null
  for (const t of colorTokens) {
    const d = dE(rgb, t.rgb)
    if (!best || d < best.d) best = { t, d }
  }
  if (rgb.a < 1) return { kind: "translucent", token: best.d < 0.0005 ? best.t : null }
  if (best.d < 0.0005) return { kind: "exact", token: best.t }
  if (best.d < 0.02) return { kind: "near", token: best.t, d: best.d }
  return { kind: "off" }
}

async function* walk(dir) {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) yield* walk(p)
    else if (EXT.test(e.name)) yield p
  }
}

const COLOR = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b|rgba?\([^)]*\)/g
const areaOf = rel => (SECONDARY?.test(rel) ? "secondary" : "product")
// The token file itself defines the colors; never flag it.
const tokenFileRel = path.relative(REPO, TOKENS)
const findings = []
for (const root of SCAN) {
  for await (const abs of walk(path.resolve(REPO, root))) {
    const rel = path.relative(REPO, abs)
    if (rel === tokenFileRel) continue
    const src = await fs.readFile(abs, "utf8")
    // A deliberate, reviewed exception: `design-audit: allow-file <why>` once at the top of
    // a file, or `design-audit: allow <why>` in a comment on the line itself. The reason is
    // required, so the exception is argued where it lives rather than in a baseline.
    if (/design-audit: allow-file \S/.test(src)) continue
    const lines = src.split("\n")
    let inComment = false
    lines.forEach((line, i) => {
      if (/design-audit: allow \S/.test(line)) return
      // CSS comments (including multi-line ones) and JS line comments document colors;
      // they don't render them.
      let code = line
      if (inComment) {
        const end = code.indexOf("*/")
        if (end === -1) return
        code = code.slice(end + 2)
        inComment = false
      }
      code = code.replace(/\/\*.*?\*\//g, "")
      const open = code.indexOf("/*")
      if (open !== -1) {
        code = code.slice(0, open)
        inComment = true
      }
      code = code.replace(/^\s*(\/\/|\*).*/, "")
      // A mask is an alpha stencil: its black means "opaque", not a color choice.
      if (/^\s*(-webkit-)?mask(-image)?\s*:/.test(code)) return
      for (const m of code.matchAll(COLOR)) {
        // `#abc` in JS is often an id/anchor (`href="#top"`); only count it in CSS or
        // where it sits in a string that is clearly a color.
        if (
          !rel.endsWith(".css") &&
          !/['"`]\s*$|:\s*$|\(\s*$/.test(code.slice(0, m.index)) &&
          !m[0].startsWith("rgb")
        )
          continue
        const rgb = parse(m[0])
        if (!rgb) continue
        findings.push({
          rule: "raw-color",
          area: areaOf(rel),
          file: rel,
          line: i + 1,
          value: m[0].toLowerCase(),
          rgb,
          ...classify(rgb)
        })
      }
      for (const m of code.matchAll(/color-mix\(in srgb, var\((--[\w-]+)\) ([\d.]+)%, transparent\)/g)) {
        const allowed = STRENGTHS[m[1]]
        if (allowed && !allowed.includes(+m[2]))
          findings.push({
            rule: "off-strength",
            area: areaOf(rel),
            file: rel,
            line: i + 1,
            value: `${m[1]} ${m[2]}%`,
            kind: "strength",
            allowed
          })
      }
      if (rel.endsWith(".css")) {
        // Spacing sits on the grid. A small optical nudge is argued on its line with an
        // allow marker like any other exception.
        for (const m of code.matchAll(/(?:^|[\s;{])(?:padding|margin|gap|row-gap|column-gap)(?:-[a-z-]+)?\s*:([^;}]*)/g)) {
          for (const v of m[1].matchAll(/(-?\d*\.?\d+)px/g)) {
            const px = Math.abs(parseFloat(v[1]))
            if (px && px % GRID)
              findings.push({
                rule: "off-grid",
                area: areaOf(rel),
                file: rel,
                line: i + 1,
                value: `${px}px`,
                kind: "grid"
              })
          }
        }
        for (const m of code.matchAll(/(--[\w-]+)\s*:/g)) {
          if (tokenVars.has(m[1]))
            findings.push({
              rule: "token-redefined",
              area: areaOf(rel),
              file: rel,
              line: i + 1,
              value: m[1],
              kind: "redefined"
            })
        }
      }
    })
  }
}

// --json: every finding with file and line, for scripted cleanups.
if (process.argv.includes("--json")) {
  console.log(JSON.stringify(findings.map(({ rgb, ...f }) => ({ ...f, token: f.token?.cssVar ?? null })), null, 1))
  process.exit(0)
}

const keyOf = f => `${f.rule}|${f.value}`
const counts = {}
for (const f of findings) (counts[f.file] ??= {})[keyOf(f)] = (counts[f.file]?.[keyOf(f)] ?? 0) + 1

if (mode === "update") {
  const sorted = Object.fromEntries(
    Object.keys(counts)
      .sort()
      .map(f => [f, Object.fromEntries(Object.entries(counts[f]).sort())])
  )
  await fs.writeFile(
    BASELINE,
    JSON.stringify(
      {
        $comment: "Generated by audit.mjs --update-baseline. Counts may only go down.",
        files: sorted
      },
      null,
      2
    ) + "\n"
  )
  console.log(
    `✓ baseline written: ${findings.length} existing findings across ${Object.keys(counts).length} files`
  )
  process.exit(0)
}

const baseline = JSON.parse(await fs.readFile(BASELINE, "utf8").catch(() => '{"files":{}}')).files
const fresh = []
for (const [file, byKey] of Object.entries(counts)) {
  for (const [key, n] of Object.entries(byKey)) {
    const allowed = baseline[file]?.[key] ?? 0
    if (n > allowed)
      fresh.push(...findings.filter(f => f.file === file && keyOf(f) === key).slice(allowed))
  }
}
const fixed = Object.entries(baseline).reduce(
  (sum, [file, byKey]) =>
    sum +
    Object.entries(byKey).reduce((s, [k, n]) => s + Math.max(0, n - (counts[file]?.[k] ?? 0)), 0),
  0
)

const advice = f =>
  f.rule === "token-redefined" ?
    `${f.value} is a design token; redefining it here forks the source of truth. Edit ${TOKENS_HINT} instead.`
  : f.kind === "exact" ? `${f.value} is ${f.token.cssVar}; use var(${f.token.cssVar}).`
  : f.kind === "translucent" ?
    `${f.value} is a translucent literal${f.token ? ` of ${f.token.cssVar}` : ""}; use an existing shadow token or propose an overlay token.`
  : f.kind === "grid" ?
    `${f.value} is off the ${GRID}px spacing grid. Use the nearest multiple of ${GRID}.`
  : f.kind === "strength" ?
    `${f.value} is not one of the set strengths for that token (${f.allowed.join(", ")}%). Use the nearest.`
  : f.kind === "near" ?
    `${f.value} is ΔE ${f.d.toFixed(3)} from ${f.token.cssVar} (${f.token.hex}); almost certainly meant to be it.`
  : `${f.value} is not in the design system. Use a token, or propose a new one.`

if (mode === "report") {
  for (const area of SECONDARY ? ["product", "secondary"] : ["product"]) {
    const list = findings.filter(f => f.area === area)
    const by = k => list.filter(f => f.kind === k).length
    console.log(
      `\n== ${area} (${list.length}): ${by("exact")} exact token matches, ${by("near")} near-misses, ${by("off")} off-system, ${by("translucent")} translucent, ${by("strength")} off-strength, ${by("redefined")} token redefinitions\n`
    )
    // Clusters are the useful view for proposals: one decision fixes many lines.
    const clusters = {}
    for (const f of list.filter(x => x.rule === "raw-color")) {
      const k =
        f.kind === "off" ? `off ${hex(f.rgb)}`
        : f.kind === "translucent" ? `translucent ${hex(f.rgb)}`
        : `${f.kind} ${f.token.cssVar}`
      const c = (clusters[k] ??= { n: 0, values: new Set(), files: new Set(), f })
      c.n++
      c.values.add(f.value)
      c.files.add(f.file)
    }
    for (const [k, c] of Object.entries(clusters)
      .sort((a, b) => b[1].n - a[1].n)
      .slice(0, area === "product" ? 30 : 10)) {
      console.log(
        `${String(c.n).padStart(4)}×  ${k.padEnd(26)} ${[...c.values].slice(0, 4).join(" ")}${c.values.size > 4 ? " …" : ""}  (${c.files.size} file${c.files.size > 1 ? "s" : ""})`
      )
    }
  }
  process.exit(0)
}

if (fresh.length) {
  console.error(`✗ ${fresh.length} new design-system violation(s):\n`)
  for (const f of fresh) {
    console.error(`  ${f.file}:${f.line}  ${advice(f)}`)
    // In GitHub Actions this becomes a red note on that line of the PR diff.
    if (process.env.GITHUB_ACTIONS)
      console.log(`::error file=${f.file},line=${f.line},title=Design system::${advice(f)}`)
  }
  console.error(
    `\nFix them with a token, or if one is a deliberate exception, argue it on the line with` +
      ` /* design-audit: allow <why> */ and say so in review.`
  )
  process.exit(1)
}
console.log(
  `✓ no new design-system violations (${findings.length} baselined${fixed ? `, ${fixed} paid down since the baseline: run --update-baseline to lock that in` : ""})`
)
