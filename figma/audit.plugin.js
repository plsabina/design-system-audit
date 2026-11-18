// Figma Plugin API script, read-only: the design-side twin of audit.mjs. It
// lists what a design has broken away from the system on one page:
//
//   raw-color      a solid fill, stroke or shadow color not bound to a variable (a hex
//                  typed onto the layer, or a variable that was detached)
//   no-text-style  a text layer with no text style
//   style-override a text layer whose font, size, line height or spacing differs from
//                  its text style
//   detached       a frame that was a component instance until someone detached it
//   broken         an instance whose main component is gone
//   missing-font   a text layer using a font Figma can't load
//
// It also returns `components`: every main component on the page with a fingerprint
// of its structure (layers, sizes, layout, colors, text styles, properties). Save one
// run's output and diff the hashes against a later run to see which components were
// added, changed, renamed or deleted.
//
// Runs anywhere the Plugin API does: through an agent's use_figma tool (the body is
// written to be wrapped in an async function, hence the top-level return), or pasted
// into a development plugin. Set PAGE to a page name, or leave it empty to audit the
// current page.
//
// Not flagged: image fills, gradients, invisible paints, section backgrounds (canvas
// organization, not design), any layer inside one whose name matches EXEMPT (content
// colors that aren't meant to be tokens), and missing fonts matching LOCAL_FONTS: fonts
// designers have installed that Figma's servers can't load.
// Inside a component instance only overridden fills/strokes count, so a problem in a
// main component is reported once, on the component, not once per instance.
const PAGE = ""
const LOCAL_FONTS = [] // e.g. [/^My Display Font\b/]
const EXEMPT = /content colou?r/i

const page = PAGE ? figma.root.children.find(p => p.name === PAGE) : figma.currentPage
if (!page) return { page: PAGE, error: `No page named "${PAGE}"` }
await figma.setCurrentPageAsync(page)

const hex = c =>
  "#" +
  [c.r, c.g, c.b]
    .map(x =>
      Math.round(x * 255)
        .toString(16)
        .padStart(2, "0")
    )
    .join("")
const pathOf = n => {
  const parts = []
  for (let p = n; p && p.type !== "PAGE"; p = p.parent) parts.unshift(p.name)
  return parts.join(" › ")
}
const exempt = n => {
  for (let p = n; p && p.type !== "PAGE"; p = p.parent)
    if (EXEMPT.test(p.name)) return true
  return false
}
const insideInstance = n => {
  for (let p = n.parent; p && p.type !== "PAGE"; p = p.parent) if (p.type === "INSTANCE") return p
  return null
}

// Overridden fields per node inside instances: { nodeId: Set(fields) }
const overridden = new Map()
for (const inst of page.findAllWithCriteria({ types: ["INSTANCE"] }))
  for (const o of inst.overrides ?? []) {
    const set = overridden.get(o.id) ?? new Set()
    for (const f of o.overriddenFields) set.add(f)
    overridden.set(o.id, set)
  }

const findings = []
const add = (n, kind, extra) =>
  findings.push({ kind, id: n.id, path: pathOf(n), type: n.type, ...extra })

const styleCache = new Map()
const styleOf = async id => {
  if (!styleCache.has(id)) styleCache.set(id, await figma.getStyleByIdAsync(id))
  return styleCache.get(id)
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

for (const n of page.findAll(() => true)) {
  if (n.type === "SECTION" || exempt(n)) continue
  const inInstance = insideInstance(n)
  const fields = overridden.get(n.id)
  for (const prop of ["fills", "strokes"]) {
    if (!(prop in n)) continue
    if (inInstance && !fields?.has(prop)) continue
    const paints = n[prop]
    if (!Array.isArray(paints)) continue
    for (const p of paints) {
      if (p.type !== "SOLID" || p.visible === false || p.boundVariables?.color) continue
      if (prop === "fills" && n.fillStyleId) continue
      if (prop === "strokes" && n.strokeStyleId) continue
      add(n, "raw-color", {
        prop:
          n.type === "TEXT" && prop === "fills" ? "text color"
          : prop === "fills" ? "fill"
          : "stroke",
        hex: hex(p.color),
        alpha: Math.round((p.opacity ?? 1) * 100) / 100
      })
    }
  }
  if ("effects" in n && !n.effectStyleId && (!inInstance || fields?.has("effects")))
    for (const e of n.effects ?? [])
      if (
        (e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW") &&
        e.visible !== false &&
        !e.boundVariables?.color
      )
        add(n, "raw-color", {
          prop: "shadow",
          hex: hex(e.color),
          alpha: Math.round(e.color.a * 100) / 100
        })

  if ("detachedInfo" in n && n.detachedInfo) {
    let from = null
    if (n.detachedInfo.type === "local")
      from = (await figma.getNodeByIdAsync(n.detachedInfo.componentId))?.name ?? null
    add(n, "detached", { from, library: n.detachedInfo.type === "library" })
  }
  if (n.type === "INSTANCE") {
    const main = await n.getMainComponentAsync()
    if (!main) add(n, "broken", {})
  }
  if (
    n.type === "TEXT" &&
    n.hasMissingFont &&
    !(n.fontName !== figma.mixed && LOCAL_FONTS.some(re => re.test(n.fontName.family)))
  )
    add(n, "missing-font", {
      text: n.characters.slice(0, 40),
      font: n.fontName === figma.mixed ? "mixed" : `${n.fontName.family} ${n.fontName.style}`
    })
  if (n.type === "TEXT" && (!inInstance || fields?.has("textStyleId") || fields?.has("fontSize"))) {
    const sid = n.textStyleId
    if (!sid || sid === figma.mixed) {
      add(n, "no-text-style", { text: n.characters.slice(0, 40), mixed: sid === figma.mixed })
      continue
    }
    const s = await styleOf(sid)
    if (!s) continue
    const diffs = []
    if (n.fontSize !== figma.mixed && n.fontSize !== s.fontSize)
      diffs.push(`size ${n.fontSize} (style ${s.fontSize})`)
    if (n.fontName !== figma.mixed && !same(n.fontName, s.fontName))
      diffs.push(
        `font ${n.fontName.family} ${n.fontName.style} (style ${s.fontName.family} ${s.fontName.style})`
      )
    if (n.lineHeight !== figma.mixed && !same(n.lineHeight, s.lineHeight)) diffs.push("line height")
    if (n.letterSpacing !== figma.mixed && !same(n.letterSpacing, s.letterSpacing))
      diffs.push("letter spacing")
    if (diffs.length)
      add(n, "style-override", { style: s.name, text: n.characters.slice(0, 40), diffs })
  }
}

// Component fingerprints. Variant sets are one entry (variants folded in); a variant's
// own entry would double-report every change.
const varCode = async id => (await figma.variables.getVariableByIdAsync(id))?.codeSyntax?.WEB ?? id
const paintSig = async paints =>
  Array.isArray(paints) ?
    await Promise.all(
      paints
        .filter(p => p.visible !== false)
        .map(async p =>
          p.type !== "SOLID" ? p.type
          : p.boundVariables?.color ?
            (await varCode(p.boundVariables.color.id)) + (p.opacity < 1 ? "@" + p.opacity : "")
          : hex(p.color) + (p.opacity < 1 ? "@" + p.opacity : "")
        )
    )
  : "mixed"
const sigOf = async root => {
  const out = []
  for (const n of [root, ...(root.findAll ? root.findAll(() => true) : [])]) {
    const row = [n.type, n.name, Math.round(n.width), Math.round(n.height)]
    if ("layoutMode" in n)
      row.push(
        n.layoutMode,
        n.itemSpacing,
        n.paddingTop,
        n.paddingRight,
        n.paddingBottom,
        n.paddingLeft
      )
    if ("cornerRadius" in n) row.push(n.cornerRadius === figma.mixed ? "mixed" : n.cornerRadius)
    if ("fills" in n) row.push(await paintSig(n.fills))
    if ("strokes" in n)
      row.push(await paintSig(n.strokes), n.strokeWeight === figma.mixed ? "mixed" : n.strokeWeight)
    if ("effects" in n)
      row.push(n.effectStyleId ? (await styleOf(n.effectStyleId))?.name : n.effects.length)
    if (n.type === "TEXT")
      row.push(
        n.textStyleId && n.textStyleId !== figma.mixed ?
          (await styleOf(n.textStyleId))?.name
        : "no style",
        n.characters
      )
    if (n.type === "INSTANCE") row.push((await n.getMainComponentAsync())?.name ?? "missing")
    out.push(row)
  }
  return JSON.stringify(out)
}
const fnv = str => {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619) >>> 0
  return h.toString(16).padStart(8, "0")
}
const components = []
for (const c of page.findAllWithCriteria({ types: ["COMPONENT", "COMPONENT_SET"] })) {
  if (c.type === "COMPONENT" && c.parent?.type === "COMPONENT_SET") continue
  const props = Object.entries(c.componentPropertyDefinitions ?? {}).map(
    ([k, d]) => `${k.split("#")[0]}:${d.type}`
  )
  components.push({
    key: c.key,
    id: c.id,
    name: c.name,
    type: c.type,
    size: `${Math.round(c.width)}×${Math.round(c.height)}`,
    variants: c.type === "COMPONENT_SET" ? c.children.length : 0,
    props,
    hash: fnv(await sigOf(c))
  })
}

return {
  page: page.name,
  file: figma.root.name,
  auditedAt: new Date().toISOString(),
  findings,
  components
}
