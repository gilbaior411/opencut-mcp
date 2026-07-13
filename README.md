# opencut-mcp

MCP (Model Context Protocol) server for the OpenCut classic video editor.
Lets an LLM agent (Claude Code, Cline, etc.) drive the timeline via `window.__editor`
in a Playwright-controlled browser.

**Status**: PoC for a kenimoto.dev article series.

## Runs against a fork, not upstream

This server does **not** target [`opencut-app/opencut-classic`](https://github.com/opencut-app/opencut-classic)
(archived). It targets the **[`kenimo49/opencut-classic`](https://github.com/kenimo49/opencut-classic)
fork**, which carries a small patch series that exposes internals needed for
automation. Point your `docker compose` / `bun dev:web` at the fork's `main`.

| Patch | What it exposes | Used by which tools |
|-------|-----------------|---------------------|
| [`eca73042`](https://github.com/kenimo49/opencut-classic/commit/eca73042) — Phase 1 | `window.__editor` (the `EditorCore` singleton) | every tool |
| [`a7443ec8`](https://github.com/kenimo49/opencut-classic/commit/a7443ec8) — Phase 1.1 | `window.__opencut.mediaTimeFromSeconds` (+ `TICKS_PER_SECOND`, `mediaTime`, `roundMediaTime`) | any tool that takes a time argument (`insert_clip`, `split_at`, `move`, `trim`) |

The fork may drift further from upstream as we add hooks — e.g. `data-testid`
anchors for wait/assertion, or a headless-export toggle. Track the two together;
a version of this server may not work against an arbitrary snapshot of the fork.
Compatibility is pinned at repo level, not by semver (yet). The current commit of
this server was validated against `kenimo49/opencut-classic@a7443ec8`.

## Demo

`scripts/demo.ts` runs a full end-to-end sequence: create a project, upload a video
+ audio file, place both on the timeline via auto-placement, split the video at 5s.
The Playwright screencast below is that run recorded verbatim.

<video src="https://github.com/kenimo49/opencut-mcp/raw/main/docs/demo.mp4" controls poster="docs/demo-poster.png" width="800"></video>

<!-- Fallback for Markdown viewers that ignore <video>. GitHub renders <video> above; other viewers show the GIF. -->
![opencut-mcp demo (12 second GIF fallback)](docs/demo.gif)

## Tools

| tool | description |
|------|-------------|
| `opencut_get_state` | Timeline snapshot (tracks, elements, assets). |
| `opencut_add_track` | ⚠ empty tracks are pruned by the reactor — prefer omitting `trackId` on `insert_clip`. |
| `opencut_add_media` | Upload local file as MediaAsset. |
| `opencut_insert_clip` | Add element referencing MediaAsset. `mode: "auto"` when `trackId` omitted. |
| `opencut_split_at` | Split element(s) at a time (seconds). |
| `opencut_move` / `opencut_trim` / `opencut_delete` | direct pass-through to TimelineManager. |
| `opencut_undo` / `opencut_redo` | CommandManager history. |
| `opencut_export` | RendererManager.exportProject. |
| `opencut_screenshot` | debug: screenshot the editor viewport. |

## Running

```sh
# 1. Start the FORK of classic (docker + bun dev:web on 3000).
git clone https://github.com/kenimo49/opencut-classic.git
cd opencut-classic
# ... see that repo's README for docker compose + env.local setup
bun run dev:web   # http://localhost:3000

# 2. Install and run this MCP (in a separate shell):
cd ../opencut-mcp
bun install
bunx tsx src/index.ts   # stdio transport

# 3. Or the integration demo:
bunx tsx scripts/demo.ts
```

Env:
- `OPENCUT_BASE_URL` — default `http://localhost:3000`
- `OPENCUT_HEADLESS` — `false` to see the browser (WSLg / X11 required)
- `OPENCUT_VIDEO_DIR` — set to record a webm screencast of the browser
- `OPENCUT_DEMO_PACE=slow` — triples inter-step pauses in `scripts/demo.ts`

## Notes discovered during PoC

1. **Empty tracks are pruned** every command via `CommandManager` reactor
   (`editor/index.ts:playback.bindTimelineScope`). Two-step `addTrack` + `insertElement`
   loses the track before the second call. Prefer `insertElement` with
   `placement: { mode: "auto", trackType }` — the command creates the track on demand
   and it survives because it has an element.
2. **MediaTime is integer ticks**, not seconds. `TICKS_PER_SECOND` is 120,000 at runtime.
   Convert via `window.__opencut.mediaTimeFromSeconds({ seconds })` (Phase 1.1 exposure).
3. **AudioElement discriminated union** — uploads must carry `sourceType: "upload"`
   in addition to `mediaId`.
4. **Editor page is `/editor/[project_id]`**. Creating a project via the /projects UI
   is the boot path used by this server.

MIT.
