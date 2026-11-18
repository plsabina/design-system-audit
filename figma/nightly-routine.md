# Running the Figma check every night

The Figma script has to run inside Figma, so the nightly version is a scheduled
Claude agent with the Figma connector: it runs the audit on each page, compares the
pages, and leaves a short summary to read in the morning. It only reads the file.

Set it up as a scheduled task or routine with the Figma connector attached, give it
this repo, and use the prompt below with your own file key and page names filled in.

```
Nightly Figma check. Read only: never edit the Figma file, and never add comments
or annotations. Your only visible output is the summary at the end.

1. Read the Figma usage guide from the Figma server before any use_figma call.
   File key: <FILE_KEY>. Call create_session with it first and reuse the session.
2. List the pages with a read-only use_figma call. Audit only <WHICH PAGES, e.g.
   "pages whose name starts with Production:" or "one page per team">.
3. For each page, take figma/audit.plugin.js from this repo, set PAGE to that
   page's name, and run it with use_figma (one call per page, in parallel). Save
   each result as JSON in a temp folder.
4. Run: node figma/repeats.mjs <the JSON files>
5. Finish with a short summary:
   - per page: each finding in one plain line (page › layer: what's wrong),
     grouped as colors, text styles, detached or broken components, fonts
   - then the output of repeats.mjs under "Repeated across pages", or
     "No repeated patterns."
   If there are no findings at all, say "No design drift." If the Figma tools
   aren't available, say the check couldn't run and why.
```

Weeknights work well: the summary is waiting when the day starts, and a repeated
detach or color shows up while the decision behind it is still fresh.
