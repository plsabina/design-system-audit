// Repeated across pages: reads the output of figma/audit.plugin.js for several pages
// (one JSON file per page) and lists the deviations that show up on more than one.
//
//   node figma/repeats.mjs <audit.json…> [--min 2]
//
// One team detaching a component is a slip. Several teams detaching the same one is a
// signal: the component is missing something people need. The same goes for an
// off-system color or an unstyled text size that keeps coming back. So the output is
// framed as questions for the design system, not as errors.
//
// Point it at pages that different teams own (one page per team, or per product area)
// so "repeated" means "independently arrived at", which is what makes it a signal.
import fs from "node:fs/promises"

const args = process.argv.slice(2)
const minAt = args.indexOf("--min")
const MIN = minAt === -1 ? 2 : Number(args[minAt + 1])
const files = args.filter((a, i) => !a.startsWith("--") && (minAt === -1 || i !== minAt + 1))
if (!files.length) {
  console.error("usage: node figma/repeats.mjs <audit.json…> [--min 2]")
  process.exit(2)
}

const audits = await Promise.all(files.map(async f => JSON.parse(await fs.readFile(f, "utf8"))))

// What makes two findings "the same thing" on different pages.
const keyOf = f =>
  f.kind === "raw-color" ? `color ${f.hex}${f.alpha < 1 ? ` at ${Math.round(f.alpha * 100)}%` : ""}`
  : f.kind === "detached" ? (f.from ? `detached ${f.from}` : null)
  : f.kind === "no-text-style" ? (f.fontSize && f.fontSize !== "mixed" ? `text ${f.fontSize}px` : null)
  : f.kind === "style-override" ? `override ${f.style}: ${f.diffs.join(", ")}`
  : f.kind === "missing-font" ? `font ${f.font}`
  : null

const signal = (f, pages) =>
  f.kind === "raw-color" ?
    `${f.hex} used on ${pages} pages. This might suggest a new token is needed.`
  : f.kind === "detached" ?
    `${f.from} detached on ${pages} pages. This might suggest it needs a new variant or property.`
  : f.kind === "no-text-style" ?
    `${f.fontSize}px text without a style on ${pages} pages. This might suggest a new text style is needed.`
  : f.kind === "style-override" ?
    `${f.style} overridden the same way (${f.diffs.join(", ")}) on ${pages} pages. This might suggest the style itself is off.`
  : `${f.font} missing on ${pages} pages. Install it or swap it for a shared font.`

const groups = new Map()
for (const a of audits) {
  if (a.error) {
    console.error(`skipped ${a.page}: ${a.error}`)
    continue
  }
  for (const f of a.findings) {
    const k = keyOf(f)
    if (!k) continue
    const g = groups.get(k) ?? { f, pages: new Map() }
    const layers = g.pages.get(a.page) ?? []
    layers.push(f.path.split(" › ").slice(-2).join(" › "))
    g.pages.set(a.page, layers)
    groups.set(k, g)
  }
}

const repeated = [...groups.values()]
  .filter(g => g.pages.size >= MIN)
  .sort((a, b) => b.pages.size - a.pages.size)

if (process.argv.includes("--json")) {
  console.log(
    JSON.stringify(
      repeated.map(g => ({ signal: signal(g.f, g.pages.size), pages: Object.fromEntries(g.pages) })),
      null,
      1
    )
  )
  process.exit(0)
}

if (!repeated.length) {
  console.log(`No repeated patterns across ${audits.length} pages.`)
  process.exit(0)
}
console.log(`Repeated across pages: signals for the design system\n`)
for (const g of repeated) {
  console.log(`- ${signal(g.f, g.pages.size)}`)
  for (const [page, layers] of g.pages)
    console.log(`    ${page}: ${[...new Set(layers)].slice(0, 3).join("; ")}${layers.length > 3 ? " …" : ""}`)
}
