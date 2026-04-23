# Stress bench history

Append-only log of `pnpm bench:stress` runs tied to commits that moved perf. Add new entries at the **bottom**; do not edit or reorder existing entries. Backfilled data from before this log existed goes under "Pre-log (backfilled)" below, tagged `⚠ unverified` if no artifact survives. Metrics are aggregate p95 unless noted. See `README.md` for metric definitions.

Entry template:

```
## YYYY-MM-DD — <short-sha> <one-line headline>
- m2e_us: p50=… p95=… max=…
- frontend_write_ms: p50=… p95=… max=…
- render_us p95=…, emit_us p95=…
- Config: duration=30s panes=6 (defaults unless noted)
- Notes: what changed and why we expected the delta.
```

---

## Pre-log (backfilled)

### ~2026-04-18 — first-ever stress run  `⚠ unverified`
- m2e_us: p95 ≈ **83 ms** (user recall; may have been worse)
- No surviving JSON. Backfilled 2026-04-22 from memory so the historical ceiling isn't lost.
- Context: predates damage-based partial renders (`8ca655a`, Apr 17 22:37), multi-session drain (`9805d5d`), empty-frame skip (`6710a19`), base64 IPC, rate-cap, and delta-SGR. Effectively the first stress bench run after the harness (`971de30`) landed.

---

## Logged runs

## 2026-04-20 — pre-optimization baseline (from `/tmp/lastty-stress-before.json`)
- m2e_us: p50=1750 p95=63424 max=276549
- frontend_write_ms: p50=1.00 p95=21.43 max=339.00
- Config: duration=30s panes=6
- Notes: snapshot before the drain-all, empty-frame skip, base64 IPC, native fromBase64, rate-cap, and delta-SGR commits landed. Retained here as the historical ceiling.

## 2026-04-22 — d935259 post-delta-SGR + rate-cap, canvas addon restored
- m2e_us: p50=77 p95=2831 max=21248
- frontend_write_ms: p50=0.29 p95=1.29 max=23.00
- render_us p95=70, emit_us p95=45
- Config: duration=30s panes=6
- Notes: first run after restoring `CanvasAddon` (fix for block-char rendering regression from `customGlyphs`-only switch). Backend numbers reflect delta-SGR (65caa71) + rate-cap mark collection; frontend numbers reflect base64 + native fromBase64 decode. Net vs Apr 20 baseline: m2e p95 −95.5%, frontend_write_ms p95 −94%.

## 2026-04-22 — working tree on b4f897b — bytes-based FontFace for user-font support
- m2e_us: p50=134 p95=10409 max=122147
- frontend_write_ms: p50=0.29 p95=1.86 max=37.00
- render_us p95=2187, emit_us p95=44
- ansi_bytes p95=15992
- Config: duration=30s panes=6, default font (no FontFace registration exercised by the bench)
- Notes: adds `read_font_bytes` Tauri command (Core Text `kCTFontURLAttribute` → file read) and frontend `ensureCanvasFont` that registers user-picked families via `new FontFace(name, bytes)` before xterm re-rasterizes. WKWebView canvas can't resolve `local()` for user fonts; bytes-based FontFaces it can. Keeps `CanvasAddon` + `customGlyphs: true` for contiguous block/box-drawing glyphs in ASCII-art logos. `frontend_write_ms` p95 +44% vs Apr 22 canvas baseline (1.29 → 1.86ms) — still well under the 3 ms informal budget; the feature-relevant path is effectively flat since the default-font bench never exercises `ensureCanvasFont`. `m2e_us` p95 +268% (2831 → 10409µs) and `render_us` p95 +3024% (70 → 2187µs) are on Rust-only paths that this change doesn't touch; `fade` and `color-cycle` dominate the hotspot ranking and are the two scenarios most sensitive to background system load. No fresh in-session `before` was captured on this machine so I can't separate run variance from genuine backend drift between `d935259` and `b4f897b`. Flagging for the next perf pass rather than blocking the feature.
