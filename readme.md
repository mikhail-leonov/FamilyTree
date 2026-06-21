# Family Tree

A private, browser-based genealogy app. Build and explore a single family tree entirely on your own machine — no server, no account, no data leaving your browser. Everything is stored locally in IndexedDB, and the whole app is plain HTML, CSS, and vanilla JavaScript (no build step, no framework).

The interface ships in English and Russian, with a warm "Heirloom" parchment theme.

---

## Features

- **Dashboard** — at-a-glance counts (people, living/deceased, marriages, events, distinct surnames, earliest recorded birth) plus a "recently edited" list.
- **People** — paginated, sortable (last name / first name / birth date), prefix-searchable list. Optional deep search across notes and biography.
- **Person editor** — full record editing: identity, partial dates (`1900`, `1900-05`, or `1900-05-17`), living/deceased status, parent/child links with relationship kinds (biological, adoptive, step, foster, guardian, unknown), marriages/partnerships, life events, and photo/document references (a thumbnail and metadata are stored — the original file stays on your computer).
- **Interactive tree viewer** — a canvas "hourglass" view showing ancestors above and descendants below a focus person. Pan, wheel/pinch zoom, full keyboard navigation, and touch support. Cards carry on-card quick-add controls (parent, child, spouse) and tabs to reveal off-screen relatives. A synchronized side panel edits the selected person in place. Couples are drawn as pairs; siblings always connect through a shared parent, never to each other.
- **Story view** — auto-generated prose biography and a chronological timeline that weaves in parents', the subject's, and children's key dates. Printable.
- **Import / Export**
  - Import **GEDCOM** 5.5, 5.5.1, and 7.0 (unknown tags are skipped).
  - Export **GEDCOM 5.5.1** for other genealogy software.
  - Export / import a lossless **native JSON** backup (people, relationships, marriages, events, media).
  - All imports run through a **conflict-aware, de-duplicating merge**: matching people are reconciled field by field, blanks are back-filled, genuine disagreements are logged (and downloadable) rather than overwritten.
- **Localization** — drop-in language packs; English and Russian included.

---

## Getting started

The app is fully static, so it just needs to be served over HTTP (opening `index.html` directly via `file://` will not work because browsers restrict IndexedDB and module loading on the file protocol).

On first run the database is created empty. Head to **Tree** to name your family and add the first person, or go to **Import / Export** to load a GEDCOM or JSON file.

> All data lives in your browser's IndexedDB under the database name `FamilyTreeDB`. Clearing site data (or using the **Danger zone → Erase all data** button) permanently removes it, so export a JSON backup before doing either.

---

## Project structure

```
index.html                     App shell + script load order
public/
  css/
    styles.css                 Heirloom theme, tree workspace layout, viewport-fit rules
  fonts/                        Fraunces (display) + Spline Sans (body)
  js/
    i18n.js                    Localization engine
    lng/
      en.js                    English language pack
      ru.js                    Russian language pack
    core.js                    Global state (FT.State) + DOM/UI helpers (FT.H)
    db.js                      IndexedDB open/upgrade + low-level helpers
    models.js                  Entity factories, normalization, validation
    services/
      data-service.js          CRUD + integrity + de-duplicating batch merge
      search-service.js        Indexed prefix search + bounded free-text scan
      tree-service.js          Bounded "focus graph" assembly for the viewer
      story-service.js         Narrative + timeline generation
    gedcom-parser.js           GEDCOM 5.5/5.5.1/7.0 -> internal schema
    gedcom-exporter.js         Tree -> GEDCOM 5.5.1 and native JSON
    tree-renderer.js           Interactive canvas tree engine
    ui/
      dashboard.js             Dashboard page
      people.js                People list page
      editor.js                Full person editor page
      tree.js                  Tree workspace page controller
      story.js                 Story (narrative/timeline) page
      io.js                    Import / Export page
    app.js                     Hash router + bootstrap (loads last)
```

Everything attaches to a single global namespace, `window.FT`. Modules are plain IIFEs loaded in dependency order by `index.html` — `core.js` first (so `FT.State`/`FT.H` exist), then storage, models, services, parsers, the renderer, the UI pages, and finally `app.js`, which wires the router and boots the app.

---

## Architecture notes

**Storage (`db.js`).** IndexedDB schema version 6. Object stores: `trees`, `persons`, `relationships`, `marriages`, `events`, `media`, `metadata`, plus `deleted_items` and `history` (reserved for soft-delete/undo). Indexes are reconciled on upgrade — stale indexes are dropped and correct ones recreated over existing data, without deleting records. Search and sort rely on lowercased `*_lc` fields and composite `[tree_id, field]` indexes so pagination uses cursor `advance()` instead of re-scanning.

**Single-tree model.** On boot (and after every import) `app.js` consolidates all records under one canonical tree id; person and relationship ids are preserved, so links keep working and nothing is duplicated.

**Bounded graph.** The tree viewer never loads the whole dataset. `tree-service.js` walks only a configurable neighbourhood — ancestors up to a depth, descendants down to a depth, plus siblings, spouses, and co-parents — and feeds that bounded graph to the canvas renderer.

**Integrity.** The data layer blocks duplicate parent-child edges and circular ancestry, dedupes marriages, and cascades cleanup (removing a person also removes their edges, marriages, media, and prunes them from events).

---

## Adding a language

1. Copy `public/js/lng/en.js` to `public/js/lng/<code>.js`.
2. Translate the `strings` map and update `name` / `nativeName` / `dir`.
3. Add a `<script src="public/js/lng/<code>.js?v=...">` tag in `index.html` (after `i18n.js`).

The new language appears in the header switcher automatically.

---

## Browser support

A current desktop or mobile browser with IndexedDB, Canvas 2D, and ES2017+ (`async`/`await`). The tree viewer uses `ResizeObserver` where available and degrades gracefully without it.

---

## Privacy

This app has no backend. Your genealogy data is never uploaded anywhere — it is stored only in your own browser. Use the JSON export to back it up or move it between machines.
