# Build Prompt — "Heirloom" Local-First Family Tree Web App

You are to build a **complete, single-page, fully client-side family-tree web application** called **Heirloom**. 
Everything runs in the browser with **no backend, no build step, and no network calls at runtime** — 
all data lives in the user's browser via **IndexedDB**. Deliver plain `index.html` + vanilla ES2017 JavaScript modules 
(IIFE namespaced under `window.FT`) + one CSS file.

Treat this document as the authoritative specification. Match the behaviors and acceptance criteria exactly.

---

## 1. Goals & Hard Constraints

- **Local-first / offline:** No server. No frameworks (no React/Vue/etc.). No bundler. The app must run by opening `index.html` (or serving the folder statically). The only external resources are Google Fonts and a Bootstrap CSS link in the `<head>` (used loosely; the app's own CSS does the real work).
- **Single global namespace:** Everything attaches to `window.FT`. Each file is an IIFE: `(function (FT){ "use strict"; ... })(window.FT);`. No ES module `import`/`export`, no globals besides `FT`.
- **Privacy:** Footer states the data never leaves the browser. No analytics, no telemetry.
- **Vanilla DOM:** Build all UI with a tiny DOM helper (`H.el`), not template strings injected as HTML (except trusted static markup). Escape user text.
- **Accessibility:** Keyboard navigable, ARIA live regions for the canvas, focusable canvas, semantic headings, labels tied to inputs.
- **Print-friendly** story pages.

---

## 2. File / Module Layout & Load Order

`index.html` loads scripts in **this exact order** (each later file may rely on earlier ones being parsed):

```
js/core.js                      (FIRST — defines FT.State and FT.H)
js/db.js                        (IndexedDB open/upgrade + low-level helpers)
js/models.js                    (entity factories, normalization, validation)
js/services/data-service.js     (CRUD + integrity + batch/merge)
js/services/search-service.js   (indexed prefix search)
js/services/tree-service.js     (focus-graph assembly)
js/services/story-service.js    (narrative + timeline)
js/gedcom-parser.js
js/gedcom-exporter.js
js/tree-renderer.js             (canvas engine)
js/ui/dashboard.js
js/ui/people.js
js/ui/editor.js
js/ui/tree.js                   (tree workspace page controller)
js/ui/story.js
js/ui/io.js
js/app.js                       (LAST — router + bootstrap)
css/styles.css                  (single stylesheet; see Design System)
```

`index.html` body skeleton: a sticky `<header class="ft-header">` with brand, nav links (`#/dashboard`, `#/people`, `#/tree`, `#/io`) and a quick-search input; a `<main id="ft-main" class="ft-main">` mount point; a `<footer class="ft-footer">`; a `<div id="ft-toasts" class="ft-toasts" aria-live="polite">`; and a decorative `<div class="ft-paper">`. Nav links carry `data-match` for active-state highlighting.

---

## 3. Core Shell (`core.js`)

Define `FT.State = { activeTreeId: null, trees: [] }` (only if not already set).

Define `FT.H` DOM helper with:
- `el(tag, attrs, children)` — creates an element; `class`→className, `html`→innerHTML, `on*`+function→`addEventListener`, otherwise `setAttribute`; children may be string/Node/array; strings become text nodes.
- `esc(s)` — HTML-escape `& < > " '`.
- `clear(node)` — remove all children.
- `toast(msg, kind)` — append a `.ft-toast` (`info|success|error`) into `#ft-toasts`, animate in, auto-remove after ~3.2s.
- `confirm(msg)` — `window.confirm` wrapper.
- `go(hash)` — set `window.location.hash`.
- `download(filename, text, mime)` — Blob + object URL + temporary `<a download>`.

---

## 4. Data Model (`models.js`)

Factories produce normalized records. IDs use `crypto.randomUUID()` when available, else a timestamp+random fallback. Timestamps are ISO strings. A `lc()` helper lowercases+trims.

**Entities & fields:**

- **person**: `id, tree_id, first_name, middle_name, last_name, maiden_name, nickname, gender, birth_date, death_date, living (0|1), birth_place, death_place, residence, biography, notes, occupation, education, profile_photo_id, created, updated`. Plus generated lowercase search fields: `first_name_lc, last_name_lc, maiden_name_lc, nickname_lc, occupation_lc, birth_place_lc`. `gender ∈ {male, female, other, unknown}` (default `unknown`). `living` is stored as numeric `1|0` (accept `true/"1"/1` as living).
- **relationship** (parent-child edge): `id, tree_id, type:"parent-child", subtype, parent_id, child_id, created`. `subtype ∈ {biological, adoptive, step, foster, guardian, unknown}` (default `biological`).
- **marriage**: `id, tree_id, spouse1_id, spouse2_id, marriage_date, divorce_date, location, notes, created, updated`.
- **event**: `id, tree_id, type, custom_label, date, location, description, people:[ids], created, updated`. `type ∈ {birth, death, marriage, divorce, adoption, graduation, immigration, military_service, custom}`.
- **media**: `id, tree_id, person_id, kind, name, mime, data, thumbnail, size, tags:[], description, created`. (Originals are NOT stored — only metadata + a small generated thumbnail; see Editor.)
- **tree**: `id, name, description, created, updated`.

**Dates are partial-friendly:** accept `YYYY`, `YYYY-MM`, or `YYYY-MM-DD` everywhere. Provide:
- `isValidPartialDate(d)` → regex `^\d{4}(-\d{2}(-\d{2})?)?$`.
- `dateLow(d)` / `dateHigh(d)` → expand a partial date to the earliest/latest concrete day (used for range comparisons).

**Display helpers:**
- `fullName(p)` → "first middle last", fallback to maiden, else "Unnamed"/"Unknown".
- `displayLines(p)` → `{ line1, line2 }` where line1 = "first last" (fallback maiden/nickname/"Unnamed") and **line2 = middle name OR a single space `" "`** (never empty — preserves card row height).
- `lifeSpan(p)` → "b–d" / "b–" / "?–d" / "" / "deceased" using 4-digit years and an en-dash.

**Validation** (`validatePerson`): require at least one of first/last/maiden/nickname; reject when `dateLow(birth) > dateHigh(death)` (so `1900-05-01` vs `1900` is NOT a false positive).

Export `FT.Models` with all factories, helpers, and the constant lists `SUBTYPES, EVENT_TYPES, GENDERS`.

---

## 5. IndexedDB Layer (`db.js`)

Database `FamilyTreeDB`, version `5`. On `onupgradeneeded`, **reconcile** stores and indexes against a declarative `SCHEMA` (create missing stores; drop indexes whose name/keyPath/multiEntry don't match; recreate correct ones) **without deleting records**.

**Stores & indexes:**
- `trees` (key `id`): index `name`.
- `persons` (key `id`): `tree_id`; search indexes on the `*_lc` fields named `last_name, first_name, maiden_name, nickname, occupation, birth_place`; composite sort indexes `tree_last [tree_id,last_name_lc]`, `tree_first [tree_id,first_name_lc]`, `tree_birth [tree_id,birth_date]`, `tree_updated [tree_id,updated]`.
- `relationships` (key `id`): `tree_id, parent_id, child_id`, composite `edge [parent_id,child_id]`.
- `marriages` (key `id`): `tree_id, spouse1_id, spouse2_id`.
- `events` (key `id`): `tree_id, type`, multiEntry `people`.
- `media` (key `id`): `tree_id, person_id`.
- `metadata` (key `key`).
- `deleted_items` (key `id`): `tree_id`. `history` (key `id`): `tree_id`. (Present for spec completeness.)

**Helper API** (`FT.DB`): `open()`, `get(store,key)` (reject invalid keys), `put`, `del`, `getAll`, `byIndex(store,index,range,limit=0)` (cursor read), `page(store,index,range,direction,offset,limit)` (cursor with `advance(offset)` — O(1) paging, NOT re-scan from zero), `countByIndex`, `cursor(store,index,range,dir,cb)` (callback may return `false` to stop), `clearAll`, `reqP(request)` (promisify an `IDBRequest`), and `tx(storeNames, mode, callback)`.

`tx`: `callback(stores, transaction)` receives a **name→objectStore map as the first arg**; the promise resolves with the callback's return value once the transaction **commits**, and rejects (aborting) if the callback throws.

---

## 6. Data Service & Integrity (`services/data-service.js`)

Expose `FT.Data = { Persons, Relationships, Marriages, Events, Media, Batch, isAncestor }`.

- **Persons:** `save` (normalize + validate, then put), `get`, `getMany`, `countInTree`, and `remove(id)` — a single transaction that deletes the person **and every reference**: parent/child edges (both directions), marriages (both spouse indexes), media; and removes the person from each event's `people[]`, deleting the event only if it becomes empty and is not `custom`.
- **Relationships:** `addParentChild(parentId, childId, subtype)` with integrity checks: both required, not self, **no duplicate edge** (composite `edge` index — update subtype if changed), **no circular ancestry** (`isAncestor(child, parent)` BFS over `child_id`). `removeEdge`, `parentsOf(childId)`, `childrenOf(parentId)`.
- **Marriages:** `save` (require two distinct spouses; reject divorce-before-marriage; dedupe identical active pair unless editing), `get`, `remove`, `forPerson` (union of both spouse indexes, de-duplicated).
- **Events / Media:** `save/get/remove/forPerson` (+ `Events.byType`).
- **Batch.insert(payload)**: bulk put across stores in one transaction (no dedup).
- **Batch.merge(payload, treeId)** — the de-duplicating importer used by **both** GEDCOM and JSON import. Match existing persons by identity key = lowercased `first middle (last|maiden)` + `|birth_date|death_date`; unnamed people never auto-merge. Build an incoming-id→canonical-id remap; insert only genuinely new persons; **back-fill blank fields** on matched persons (a whitelist of safe fields; also upgrade `gender` from `unknown`). Remap and **skip duplicate** relationships (`parent>child`), marriages (sorted spouse pair), events (`type|date|sorted-people|label`), and media. Return `{ treeId, stats:{persons, merged, relationships, marriages, events, media} }`.

---

## 7. Search (`services/search-service.js`)

`FT.Search.search(term, opts)` — indexed **prefix** search over the six `*_lc` indexes using a key range `[lc, lc+"\uffff"]`, tree-scoped, de-duplicated, each result tagged with which fields matched (`_matched`). Optional `includeNotes` does a bounded cursor scan over `notes`/`biography`. Sort by `last+first`, cap by `limit`. Also export `prefixRange`.

---

## 8. Focus-Graph Service (`services/tree-service.js`)

`FT.Tree` assembles a **bounded neighbourhood** around a focus person — never the whole dataset.

- `person(id)`, `hasParents(id)`, `ancestorFlags(ids)` (id→bool), and **`parentCounts(ids)`** (id→number of parent edges; drives the ancestor cue and the "add parent" limitation).
- `ancestors(rootId, maxDepth)` / `descendants(rootId, maxDepth)` — BFS up/down via `parentsOf`/`childrenOf`, returning `{ nodes:Map(id→{person,depth}), edges:[{parent,child,subtype}] }`.
- `siblings(id)` — anyone sharing ≥1 parent; `half=true` when they don't share ALL of this person's parents (full only when all shared).
- `spouses(id)` — from marriages, with `ex = !!divorce_date` and the marriage record.
- `family(id)` — immediate snapshot `{ me, parents, children, siblings, spouses }` used by the editor/story.
- `focusGraph(rootId, upDepth, downDepth)` — returns `{ root, ancestors, descendants, spouses, siblings, childParents, coParents, coMarriage }`. **Co-parent assembly (important):** the descendant walk only follows parent→child links, so for every *shown* child, look up its full parent set and pull in any missing co-parent (the in-law spouse) as a node, plus marriage metadata keyed by sorted pair — so married/partnered pairs render together as a family unit and children descend from the couple's midpoint. Tolerate missing/unknown parents.

---

## 9. Story Service (`services/story-service.js`)

- `narrative(personId)` — prose biography assembled from `family()`: birth sentence; parents ("child of" / "raised by" if adoptive); siblings (full vs half); education/occupation; each marriage (date/place, divorce year); children count + names; residence; death or "recorded as living"; then free-text biography. Use gendered pronouns (`he/she/they`), `listify` for name lists, `aOrAn`, and a `nice(date)` formatter that respects partial dates.
- `timeline(personId)` — merge birth, marriages/divorces, events, death into a list sorted by date (undated last), each `{date, type, text}`.

---

## 10. GEDCOM & JSON I/O

**Parser (`gedcom-parser.js`):** Tokenize GEDCOM 5.5/5.5.1/7.0 into a nested node tree (handle `CONC`/`CONT` continuation, `@XREF@`). Map `INDI`→person (parse `NAME "Given /Surname/"`, `SEX`, `BIRT`/`DEAT` date+place via a robust `gedDate` that strips qualifiers like `ABT/EST/BEF` and converts month abbreviations to ISO, `OCCU`, `NOTE`). **Living inference:** no `DEAT` tag ⇒ living *unless* birth year is older than `MAX_LIFESPAN` (110) ⇒ deceased. Map `FAM`→parent-child edges (both parents, `biological`) + marriage record + marriage/divorce events. Return `{ payload, stats }`. Unknown tags are ignored gracefully.

**Exporter (`gedcom-exporter.js`):** `toGEDCOM(treeId)` reconstructs `INDI` + synthesized `FAM` records from parent-child edges grouped by parent-set, merged with marriage records; writes a valid 5.5.1 file (HEAD/GEDC/CHAR UTF-8, NAME/NICK/SEX/BIRT/DEAT/OCCU/EDUC/RESI/NOTE, FAMS/FAMC, HUSB/WIFE/CHIL/MARR/DIV, CONT for multiline notes). `toJSON(treeId)` = lossless native backup `{format, version, exported, tree, persons, relationships, marriages, events, media}`. `fromJSON(text)` routes through `Batch.merge` (de-duplicating). Also export `gedDateOut`.

**IO page (`ui/io.js`):** cards for Import GEDCOM (parse→merge, report stats incl. merged count), Export GEDCOM (download `.ged`), Export JSON, Import JSON (merge + reload trees), and a **Danger zone** "Erase all data" (`clearAll` + reload). Filenames sanitized from tree name.

---

## 11. Router, Single-Tree Enforcement & Bootstrap (`app.js`)

- **Hash router:** register `route(pattern, handler)` with `:param` capture; `dispatch()` parses `#/path?query`, highlights nav via `data-match`/`href` prefix, clears `#ft-main`, runs the matched async handler, catches errors → toast. **Sanitize `page` query param** to a positive integer. Default route `#/dashboard`. Expose `FT.Router = { route, dispatch }`.
- **Single-tree model:** the app holds **exactly one** tree. `mergeAllIntoSingleTree()` consolidates every record under one canonical `tree_id` (preferring `metadata.active_tree`, else the first tree, else create "My Family"), reassigns stray records, deletes extra tree rows, sets `FT.State.activeTreeId`, persists `metadata.active_tree`. Run on boot and after imports. The tree switcher UI is removed (hide `#ft-tree-select` defensively). Keep back-compat names `FT.Trees.loadTrees/setActiveTree/renderTreeSelect/mergeAllIntoSingleTree`.
- **Bootstrap (`boot`)** on `DOMContentLoaded`: open DB, merge into single tree, load `metadata.tree_layout_settings` into `FT.State.layoutSettings` (with sensible defaults), **no demo seeding** (cold start just logs and waits for user entry/import), register routes (`/dashboard`, `/people`, `/person/:id`, `/person-new`, `/tree`, `/tree/:id`, `/story/:id`, `/io`), wire quick-search (Enter → `#/people?q=...`), `window.onhashchange → dispatch`, then `dispatch()`.

---

## 12. Pages

### Dashboard (`ui/dashboard.js`)
Stats via `index.count()` + **one bounded cursor pass** (never load all rows): People, Living (+deceased sub), Marriages, Events, Surnames (distinct), Earliest birth year. "Recently edited" via the `tree_updated` composite index read newest-first with `page(...,"prev",0,8)`. Quick-link cards to tree and IO. Header actions: View tree, + Add person.

### People (`ui/people.js`)
Paginated (25/page), sortable (`tree_last|tree_first|tree_birth`), searchable list. Non-search mode pages via `page(store, sortIndex, range, "next", page*size, size)`. Search mode uses `Search.search` (full list to compute correct total, then slice). Toolbar: search input (debounced, resets page), sort select, "include notes & biography" checkbox. Table columns: Name (+nickname, +matched fields), Lifespan, Birthplace, Occupation, row actions (Tree/Story chips). Pager with Prev/Next + "Page x of y · N people/matches". All state encoded in the URL query.

### Editor (`ui/editor.js`)
Full record editor reachable at `#/person/:id` and `#/person-new`. Sections:
- **Identity** form grid: names, gender, **partial-date text inputs** (`YYYY-MM-DD or YYYY`, with pattern + hint — NOT `<input type=date>`, which would erase partial dates), explicit **Living/Deceased** select (so a known-deceased person without a date can be marked), birth/death places, residence, occupation, education, biography, research notes. Save → `Persons.save`; on new, redirect to the new id. Delete → confirm → `Persons.remove` → toast → back to People.
- **Family links:** list parents/children (with subtype tag + remove), siblings (derived, read-only). Typeahead person pickers to add a parent/child with a **subtype select offering all 6 kinds**; integrity errors surface as toasts.
- **Marriages:** list each with editable partial dates, location, **notes**; add via spouse picker.
- **Life events:** list + add (type select excluding birth/death/marriage/divorce, custom label, partial date validated, location, description).
- **Media:** upload stores **metadata + a generated ≤240px JPEG thumbnail only** (original never enters IndexedDB). Tiles show thumbnail/doc icon, name, mime/size/tags, description; set-as-profile and remove actions.

### Story (`ui/story.js`)
Tabs: **Narrative** (prose paragraphs from `Story.narrative`) and **Timeline** (vertical timeline from `Story.timeline`, colored dots per type). Header with portrait (use `media.data || media.thumbnail`), name, lifespan/occupation/residence. Print button (`window.print()`).

---

## 13. Tree Workspace (`ui/tree.js`) — Page Controller

A full-width workspace = **synchronized side editor panel** (left) + **flex-filled canvas stage** (right). Page state: `{ focusId, selectedId, cfg:{up:4, down:2}, view:{showSiblings,showHalf,showSpouses,showEx all true}, expanded:Set, firstPaint }`. **Default ancestors depth = 4**, descendants = 2.

**Toolbar:** focus-search (debounced typeahead → set focus), Ancestors/Descendants depth steppers (0–8/12), view toggles (Siblings/Half/Spouses/Former), and zoom controls (−, Fit, +, Expand).

**Focus persistence:** persist the current focus person to `metadata.last_focus_person` whenever it changes (search pick, depth change, refresh, double-click focus, "Center on tree", relative add). On load, `resolveFocusId` restores it (if the person still exists), else falls back to the first person in the tree, else shows an empty-state message.

**Renderer wiring** (`FT.TreeRenderer.create(stage, opts)`):
- `onAnnounce(msg)` → aria-live region.
- `onSelect(id)` → set `selectedId`, load the side editor.
- `onNavigate(id)` → re-center: set `focusId`, persist, `refresh({keepSelection:true})`.
- `onExpandParents(id)` → add to `expanded`, bump `cfg.up` (≤8), `refresh({keepSelection,keepView})`.
- `onAddRelative(id, kind)` → fetch person → `addRelative(kind, person)`.

**`refresh(opts)`:** build `focusGraph(focusId, up, down)`; persist focus; compute `parentCounts` for **every** graph id (one `parentsOf` per id) and derive `ancestorMap = count>0`; `renderer.render(graph, view, { ancestorMap, parentCounts })`; on first paint let the renderer fit, otherwise `renderer.reset()` unless `keepView`; keep selection in sync; load the side editor; `history.replaceState('#/tree/'+focusId)`.

**Side editor panel** (`loadEditor`): compact two-column form bound to the selected person (names, gender, partial dates, Living/Deceased, birthplace, occupation, notes) with **Save** (in-place: `Persons.save` then `refresh({keepSelection,keepView})`), **Center on tree** (set focus), and **Delete…**. Plus chips to Full edit / Story.
- **Delete…:** confirm (warn it removes links/marriages/events/media, irreversible). Before removing, pick a fallback focus from the person's family (parent → child → spouse → sibling). `Persons.remove`. If the deleted person was the focus, re-center on the fallback (or any survivor); if no one remains, tear down the renderer and go to `#/dashboard`.
- **Add-relative buttons (side panel):** "+ Child", "+ Spouse", and "+ Parent" — the **Parent button is hidden once the person already has ≥2 parents**. Each calls `addRelative`.

**`addRelative(kind, person)`** (shared by side panel and on-card controls): create a new person (`first_name:"New person"`, inheriting `last_name` for child/parent); link via `addParentChild` (child/parent) or `Marriages.save` (spouse); set `selectedId` to the new person; toast; `refresh({keepSelection,keepView})` so the new card appears and is immediately editable.

---

## 14. Canvas Tree Renderer (`tree-renderer.js`) — the centerpiece

A standalone interactive **canvas** engine. `FT.TreeRenderer.create(container, opts)` returns an API: `render(graph, viewCfg, extra)`, `fit`, `zoomIn/zoomOut/reset`, `expandAll`, `collapse(id)`, `select(id)`, `setOn*` setters (`setOnSelect/setOnNavigate/setOnExpandParents/setOnAddRelative/setOnAnnounce`), `setViewCfg`, `getView/setView`, `resize`, `destroy`.

**Layout — couple-aware "hourglass":**
- Metrics: `NODE_W=200`, two-line card height `NODE_H2=72`, `SIB_GAP=30`, `COUPLE_GAP=26`, `GEN_H=150`.
- Ancestors laid out upward; a node centers beneath the midpoint of its (couple-spaced) parents.
- Descendants laid out downward with a **two-pass measure/place** algorithm so each subtree reserves at least its couple width (a wide parent pair can't overflow a neighbour). Every lineage node is paired with one chosen **co-parent**; the pair straddles the center of their children, so children descend from the **couple's midpoint**, not one parent.
- Align both halves so the root shares one x.

**Edges:**
- Parent-child: trunk from the parent-pair midpoint down to a shared horizontal **"bus"**, across, then down to each child — so a sibling set hangs off one shared bus.
- **Siblings of the root are connected ONLY through the shared parent pair** (route each sibling's connector to the same parent-pair midpoint the root descends from). **Never draw sibling-to-sibling links.** If no parent is shown, draw no connector for that sibling.
- Spouse links: clear horizontal connector between a pair; **dashed** when ended (divorce/ex), a doubled hairline when active.
- Dash patterns encode subtype: half, adoptive, step/foster/guardian, unknown.

**Card rendering:** rounded rect with subtle shadow, gender-tinted fill/stroke, root ring, selection (dashed) and hover rings. **Centered two-line name + lifespan/role subtitle** (line2 always reserves height). Truncate text with ellipsis to fit, keeping the top line clear of edge controls.

**On-card controls (per card):**
- **Add Parent** "+" on the **top edge**, **shifted right of center** — only when the person has fewer than 2 parents (fed by `parentCounts`).
- **Add Child** "+" on the **bottom edge**, **shifted left of center**.
- **Add Spouse** "+" on the **right edge**, **shifted up from center**.
- **Reveal hidden parents** chevron on the **left edge center** — only on root/lineage cards whose parents exist but aren't currently drawn (`canExpandParents`).
- **Critical:** the add "+" controls must be **offset off the edge midpoints so they never overlap the connector lines** (parent-child trunks attach at top/bottom center; spouse links at side center). Each control is a small claret circle with a "+"; the reveal control keeps a distinct up-chevron ring.
- There is **no** ancestor triangle/indicator and **no** bottom-right collapse badge on the card (removed by design).

**Interactions:**
- **Pan** (mouse drag / one-finger), **zoom** (wheel / pinch / +/− buttons; clamp ~0.08–4), **Fit** (`reset`, animated), **Expand** (clear all collapsed).
- **Single click / tap** a card → select (loads side editor). **Double-click / double-tap** a card body → **focus / re-center** the tree on that person (this replaces the removed ancestor triangle). Clicks on the "+" / reveal controls trigger their actions, not selection or focus.
- **Keyboard** (focusable canvas, ARIA label): arrow keys move the selection geometrically between relatives; **Enter** focuses/re-centers the selected person; `+`/`-` zoom; `0` fits; **Space** toggles collapse on the selected node (collapse still exists via keyboard + the Expand button even though the on-card badge is gone).
- Smooth animated pan/zoom on navigation; snap on first load. Keep the selected person in the side panel even if they scroll out of the bounded graph.

**Lifecycle:** track container size with `ResizeObserver` (re-fit when the side panel opens/closes), keep **all** window/canvas listeners in the `create()` closure, and make `destroy()` remove every one of them (including `dblclick`) so revisiting the tree page never leaks listeners. The page controller tears the renderer down on hash-change away from `#/tree`.

**Render inputs:** `render(graph, viewCfg, { ancestorMap, parentCounts })`. Per node compute `hasAnc` (from `ancestorMap` or local adjacency), `parentCount`/`canAddParent` (from `parentCounts`, fallback to in-graph parents), `canExpandParents`, `collapsible`, `isRoot`, kind (`lineage|coparent|spouse|sibling`).

---

## 15. Design System (`css/styles.css`) — "Heirloom"

Archival, warm parchment + deep ink aesthetic.

- **Palette (CSS vars):** parchment `#efe6d2`/`#e7dcc3`, card `#f8f2e3`, ink `#2b2118`, muted `#8a7a61`, **claret** `#8a3b2e` (primary action), **gold** `#b5893f` (accent/active), line `#cbbb98`, good `#4d6b3f`, bad `#9a3b2e`; gender tints male/female/neutral with edges.
- **Type:** display serif **Fraunces**; body sans **Spline Sans** (Google Fonts). Headings serif; body sans.
- **Layout:** `body` is a viewport-tall **flex column** (header · main · footer); `.ft-main` flexes to fill and is itself a column with `min-height:0` so the tree workspace can consume all leftover height.
- **Components:** sticky dark header with gold underline; buttons (`.ft-btn`, `.ghost`, `.danger`, `.sm`); stat cards; tables; chips/tags (subtype-colored); toolbar/inputs; pickers with floating results; toasts (slide-in, colored left border); story timeline; print styles (hide chrome).
- **Tree workspace:** `.ft-tree-workspace` flex row (`align-items:stretch`, `min-height:0`); left `.ft-tree-editor` fixed ~332px, `overflow:auto` (scrolls internally); right `.ft-tree-stage` flex-fills with a dotted parchment background; compact two-column editor grid; toggle pills; visually-hidden aria-live region.
- **Responsive:** ≤900px stacks the editor above the stage (page scrolls; stage gets an explicit clamped height).
- **Viewport-fit (desktop):** scope with `:has()` so **only** the tree route locks to the window height and never scrolls — `@media (min-width:901px){ body:has(.ft-tree-workspace){height:100vh;overflow:hidden} .ft-main:has(.ft-tree-workspace){padding-bottom:18px} .ft-tree-workspace .ft-tree-stage{min-height:300px;max-height:100%} }`. Every other page scrolls normally.

---

## 16. Acceptance Criteria (must all hold)

1. **Single tree only** — no tree switcher; all data consolidates under one tree on boot and after import.
2. **No demo seeding** — cold start is empty; user adds people or imports GEDCOM/JSON.
3. **Partial dates** are preserved everywhere (text inputs, validation by range, GEDCOM round-trip).
4. **Living inference** on GEDCOM import respects `MAX_LIFESPAN`.
5. **Import is de-duplicating** (GEDCOM and JSON both route through `Batch.merge`); duplicates merge, blanks back-fill, references remap, duplicate edges/marriages/events skip; stats report merged count.
6. **Integrity:** no duplicate parent-child edges; no circular ancestry; deleting a person cascades to all references.
7. **Couple-aware layout:** married/partnered pairs render side-by-side; children descend from the couple midpoint.
8. **Siblings connect only through shared parents** — never sibling-to-sibling.
9. **Tree side editor is synchronized:** click selects + loads + highlights; exactly one selection; in-place save keeps view + selection.
10. **Focus persists** across sessions via `metadata.last_focus_person`; default ancestors depth = 4.
11. **On-card quick-add** controls on every card: parent (top, hidden when ≥2 parents), child (bottom), spouse (right) — **offset so they never overlap connector lines**; reveal-parents chevron on the left edge.
12. **Add relatives** also available in the side panel (with the same parent-hidden limitation).
13. **Delete person** available from the side panel with sensible re-focus.
14. **Double-click / double-tap** a card focuses (re-centers) the tree; **no green ancestor triangle**; **no bottom-right collapse badge** on cards.
15. **Viewport-fit:** the tree page never scrolls on desktop; the canvas fills the available height and tracks resize.
16. **Performance:** dashboards/lists/paging use index counts + bounded cursors, never full-store loads; the tree only ever loads a bounded neighbourhood.
17. **No memory leaks:** the renderer removes every listener on `destroy()`; the page tears it down when navigating away.
18. **Accessibility:** focusable canvas with ARIA label + live announcements; keyboard navigation (arrows/Enter/±/0/Space); labeled inputs.
19. **Privacy/offline:** zero runtime network dependency beyond fonts/CSS; data stays in IndexedDB.

---

## 17. Non-Goals / Out of Scope

- No multi-user sync, accounts, or cloud storage.
- No storing original media binaries (thumbnails + metadata only).
- No frameworks, bundlers, or transpilation.
- No server-side rendering or APIs.

---

## 18. Suggested Build Order

1. `index.html` skeleton + `core.js` (`H`, `State`) + `styles.css` base theme.
2. `db.js` (schema + helpers) → `models.js` → `data-service.js`.
3. `app.js` router + single-tree bootstrap; a trivial dashboard to verify routing.
4. `search-service.js`, then `people.js` + `editor.js` (full CRUD).
5. `tree-service.js` (focus graph) → `tree-renderer.js` (layout → drawing → interactions → on-card controls → double-click focus → destroy) → `ui/tree.js` (workspace + side editor + add/delete).
6. `story-service.js` + `story.js`.
7. `gedcom-parser.js` + `gedcom-exporter.js` + `io.js`.
8. Polish: viewport-fit CSS, responsive, accessibility, performance passes.

Deliver a working app that satisfies every acceptance criterion in §16.