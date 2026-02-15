# Diagnostics Section Redesign — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix broken vectorization status check and add static lorebook info to diagnostics.

**Architecture:** Read vector extension settings from `extension_settings.vectors` for correct source/model. Import `world_info`, `loadWorldInfo`, and `getCharaFilename` from SillyTavern to fetch character-bound lorebooks. Render static lorebook section above existing runtime section. All dynamic HTML uses `escapeHtml()` for safety.

**Tech Stack:** SillyTavern extension APIs, jQuery DOM rendering

---

### Task 1: Fix vectorization status check

**Files:**
- Modify: `index.js` — `checkVectorizationStatus()` (lines 1332-1346) and its display handler (lines 1381-1392)

**Step 1: Update `checkVectorizationStatus` to read vector settings and pass source/model**

Replace the function at line 1332. The new version reads `extension_settings.vectors` for the configured `source` and looks up the source-specific model key (e.g., `openai_model`, `ollama_model`). Returns an object with chunk count, source, and model on success.

Key changes:
- Check `vecSettings.enabled_files` — if false, vectors aren't configured for files, return null
- Map source to model key: most use `{source}_model`, but `palm`/`vertexai` use `google_model`
- Pass `source` and `model` in the request body to `/api/vector/list`
- Return `{ chunks, source, model }` instead of just a number

**Step 2: Update the display handler to show source/model info**

Replace the `.then` callback on `checkVectorizationStatus` (around line 1382). The new version renders "Yes (N chunks) via source/model" when vectorized.

**Step 3: Commit**

```bash
git add index.js
git commit -m "fix: pass source/model to vector API for correct vectorization status"
```

---

### Task 2: Add static lorebook info

**Files:**
- Modify: `index.js` — add imports (line 13 area), add `fetchCharacterLorebooks()` helper, update `updateDiagnosticsDisplay()`

**Step 1: Add imports**

Merge `getCharaFilename` into the existing utils.js import (line 13). Add a new import for `world_info` and `loadWorldInfo` from `../../../world-info.js`.

**Step 2: Add `fetchCharacterLorebooks()` helper**

Add before `updateDiagnosticsDisplay`. This function:
- Gets the character's primary lorebook from `characters[this_chid].data.extensions.world`
- Gets auxiliary books from `world_info.charLore` using `getCharaFilename(this_chid)`
- For each book name, calls `loadWorldInfo(name)` to get entries
- Returns array of `{ name, entries: [{ uid, keys, content }] }`

**Step 3: Update `updateDiagnosticsDisplay()` — replace World Info section**

Replace the single "World Info Entries" section (lines 1415-1430) with two sections:

1. **Character Lorebooks (static)** — renders a placeholder, then async-populates via `fetchCharacterLorebooks()`. Shows book name, entry count, and trigger keys for each entry. Uses `escapeHtml()` on all values.

2. **Activated Entries — Last Generation (runtime)** — keeps the existing `lastDiagnostics.worldInfoEntries` display, just with an updated heading to distinguish it from the static section.

**Step 4: Commit**

```bash
git add index.js
git commit -m "feat: add static lorebook info to diagnostics"
```

---

### Task 3: Bump version and push

**Files:**
- Modify: `manifest.json`

**Step 1: Bump version to 1.1.0** (new feature warrants minor version bump)

**Step 2: Commit and push**

```bash
git add manifest.json
git commit -m "chore: bump version to 1.1.0"
git push
```
