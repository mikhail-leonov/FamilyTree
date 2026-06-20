/* ============================================================================
 * tree/tree-renderer.js
 * Interactive CANVAS family-tree viewer (ancestor/descendant "hourglass").
 *
 * FIXES in this revision:
 *   - Wheel zoom referenced an undefined `rect` (ReferenceError on every
 *     scroll). It now computes the canvas rect inside the handler.
 *   - `toggleCollapse()` was called by the click handler but never defined
 *     (collapse/expand badges threw). It is now implemented.
 *   - Full KEYBOARD navigation (arrows walk between relatives, Enter focuses,
 *     +/- zoom, 0 fits, Space toggles collapse) with aria-live announcements.
 *   - TOUCH support (one-finger pan + tap, two-finger pinch zoom).
 *   - `destroy()` now actually works: all window/canvas listeners are stored
 *     in the create() closure and removed, so re-visiting the tree page no
 *     longer leaks accumulating global listeners.
 *
 * NEW in this revision:
 *   - On-card quick-add controls. Every node now carries three small "+"
 *     buttons attached to its edges: PARENT on the top edge, CHILD on the
 *     bottom edge, SPOUSE on the right edge. They mirror the side-panel
 *     buttons and honour the same limitation: the PARENT control disappears
 *     once the person already has two parents on record (fed via parentCounts).
 *     Clicks/taps route through onAddRelative(personId, kind).
 *   - UNIFIED parent tab. The small ▲ parent tab on the TOP edge is now shown
 *     on EVERY card kind (lineage, root, spouse, co-parent, sibling) whenever
 *     the person has parents that are not currently on screen. The previous
 *     lineage-only "ring chevron" is gone; the icon is identical everywhere.
 *     Click behaviour still adapts: lineage / root reveal their hidden parents
 *     IN PLACE, every other kind re-centres the tree on that person.
 * ========================================================================== */
window.FT = window.FT || {};
(function (FT) {
  "use strict";
  const M = FT.Models;
  // Build stamp — if you do NOT see this in the browser console, the browser is
  // running a CACHED/old tree-renderer.js (hard-reload or bump the ?v= query).
  console.log("FT.TreeRenderer build v14 — expand tab: filled nub, no chevron");
  // ── Layout metrics ───────────────────────────────────────────────────────
  // NODE_H1 = one name line + lifespan; NODE_H2 = two name lines + lifespan
  // (Req 3). GEN_H is large enough to clear the taller two-line cards plus the
  // connector "bus" drawn between generations. COUPLE_GAP is the gap between the
  // two cards of a married/partnered pair so they read as one family unit (Req 6).
  const NODE_W = 200, NODE_H1 = 56, NODE_H2 = 72;
  const SIB_GAP = 30, COUPLE_GAP = 26, GEN_H = 150, BADGE_R = 9, ANC_R = 8, EXP_R = 8, ADD_R = 9;
  // "Hidden relatives" navigation tabs: a small rectangle attached to the top
  // edge (the person HAS parents that are not on screen) and/or the bottom edge
  // (the person HAS children that are not on screen). Clicking one re-centres
  // the tree on that person — the same outcome as double-clicking the card.
  const NAV_W = 30, NAV_H = 13, NAV_GAP_TOP = 8, NAV_GAP_BOTTOM = 8;
  const C = {
    ink: "#2b2118",
    inkSoft: "#6f6353",
    edge: "#b9ab93",
    edgeHl: "#5a7a52",
    spouse: "#a78f6d",
    add: "#8a3b2e",                       // claret accent for the on-card "+" controls
    male: { fill: "#e3edf4", stroke: "#7fa6bd" },
    female: { fill: "#f7e7e4", stroke: "#c79a8e" },
    neutral: { fill: "#efe9dc", stroke: "#b3a98f" },
    rootRing: "#5a7a52",
    selRing: "#8a6d3b",
    badgeFill: "#fffdf7",
    navFill: "#cdbf9c",                    // slightly darker tan for the parent/expand tab
    shadow: "rgba(43,29,18,0.22)"
  };
  function create(container, opts) {
    opts = opts || {};
    const state = {
      canvas: null, ctx: null, dpr: window.devicePixelRatio || 1,
      t: { x: 0, y: 0, k: 1 },           // world->screen transform
      nodes: [], edges: [],
      graph: null, viewCfg: { showSiblings: true, showHalf: true, showSpouses: true, showEx: true },
      collapsed: new Set(),
      hoverId: null, selectedId: null,
      drag: null, didDrag: false,
      ancestorMap: {},                    // id -> has-ancestors? (Req 7)
      descendantMap: {},                  // id -> has-children? (drives hidden-children tab)
      parentCounts: {},                   // id -> number of parents on record (limits "add parent")
      childCounts: {},                    // id -> number of children on record
      // Req 4: selecting a node loads it into the side panel; Req 7: the
      // ancestor indicator (and Enter) re-centres the tree on a person.
      onSelect: opts.onSelect || function () {},
      onNavigate: opts.onNavigate || opts.onFocus || function () {},
      onExpandParents: opts.onExpandParents || function () {},
      onAddRelative: opts.onAddRelative || function () {},   // (personId, "child"|"spouse"|"parent")
      onAnnounce: opts.onAnnounce || function () {},
      lastRoot: null
    };
    let animRAF = null;                    // smooth pan/zoom handle (Req 7)
    let resizeObserver = null;             // container size tracker (Req 5)
    // ✅ Listener refs live in the create() closure so destroy() can see them.
    let mouseMoveHandler = null, mouseUpHandler = null, mouseDownHandler = null;
    let wheelHandler = null, keyHandler = null, dblHandler = null;
    let touchStartHandler = null, touchMoveHandler = null, touchEndHandler = null;
    const touch = { mode: null, lastX: 0, lastY: 0, startDist: 0, startK: 1, moved: false, lastTapAt: 0, lastTapX: 0, lastTapY: 0 };
    /* ------------------------------ setup ------------------------------ */
    function init() {
      container.innerHTML = "";
      const canvas = document.createElement("canvas");
      canvas.className = "ft-canvas";
      canvas.tabIndex = 0;
      canvas.setAttribute("role", "application");
      canvas.setAttribute("aria-label",
        "Family tree. Arrow keys move between relatives, Enter focuses the selected person, plus and minus zoom, zero fits the view, Space collapses a branch.");
      container.appendChild(canvas);
      state.canvas = canvas;
      state.ctx = canvas.getContext("2d");
      resize();
      window.addEventListener("resize", resize);
      // ✅ Req 5: track the CONTAINER's size (not just the window) so the tree
      // re-fits when the side editor panel opens/closes or the layout reflows.
      if (window.ResizeObserver) {
        resizeObserver = new ResizeObserver(() => resize());
        resizeObserver.observe(container);
      }
      bindInteractions();
    }
    function resize() {
      const r = container.getBoundingClientRect();
      state.dpr = window.devicePixelRatio || 1;
      state.canvas.width = Math.max(1, Math.round(r.width * state.dpr));
      state.canvas.height = Math.max(1, Math.round(r.height * state.dpr));
      state.canvas.style.width = r.width + "px";
      state.canvas.style.height = r.height + "px";
      draw();
    }
    function screenToWorld(sx, sy) {
      return { x: (sx - state.t.x) / state.t.k, y: (sy - state.t.y) / state.t.k };
    }
    /* ------------------------------ layout ------------------------------ */
    // Per-node card height depends on whether the person has a middle name,
    // which forces the second display line (Req 3).
    function nodeHeight(person) {
      return NODE_H2;
    }
    function buildAdjacency(graph) {
      const ancParents = {};   // child -> [parent]
      const descChildren = {}; // parent -> [child]
      graph.ancestors.edges.forEach((e) => {
        (ancParents[e.child] = ancParents[e.child] || []).push(e.parent);
      });
      graph.descendants.edges.forEach((e) => {
        (descChildren[e.parent] = descChildren[e.parent] || []).push(e.child);
      });
      return { ancParents, descChildren };
    }
    /* Upward (ancestor) layout. The two parents of a node are laid out as
     * neighbours and the node is centred beneath their midpoint (unchanged
     * centring; just couple-aware spacing). */
    function layoutAncestors(rootId, parentsFn) {
      const pos = {};
      const cursor = { x: 0 };
      const inProgress = new Set();
      function walk(id, depth) {
        if (pos[id]) return pos[id].x;
        if (inProgress.has(id)) { const x = cursor.x; cursor.x += NODE_W + SIB_GAP; return x; }
        inProgress.add(id);
        const kids = state.collapsed.has(id) ? [] : (parentsFn(id) || []);
        let x;
        if (!kids.length) {
          x = cursor.x; cursor.x += NODE_W + SIB_GAP;
        } else {
          const xs = kids.map((k) => walk(k, depth + 1));
          x = (xs[0] + xs[xs.length - 1]) / 2;
        }
        pos[id] = { x, y: -depth * GEN_H, depth };
        inProgress.delete(id);
        return x;
      }
      walk(rootId, 0);
      return pos;
    }
    /* Downward (descendant) layout — COUPLE AWARE (Req 6).
     * Every lineage node is paired with a co-parent (its child-sharing spouse /
     * the children's other parent) and the pair straddles the centre of their
     * children, so children visibly descend from the *pair*, not one parent.
     * Returns lineage positions, co-parent positions, and the family units used
     * to draw spouse + parent-child connectors. */
    function layoutDescendants(rootId, childrenFn, coParentOf) {
      const pos = {}, coPos = {}, families = [];
      const HALF = (NODE_W + COUPLE_GAP) / 2;
      const coupleWidth = (id) => coParentOf(id) ? (2 * NODE_W + COUPLE_GAP) : NODE_W;

      // Pass 1 — every subtree reserves at least its couple width, so a parent
      // whose card-pair is wider than its children (e.g. a single child) can no
      // longer overflow into a neighbouring family.
      const widthMemo = {}, measuring = new Set();
      function measure(id) {
        if (id in widthMemo) return widthMemo[id];
        if (measuring.has(id)) return coupleWidth(id);          // cycle guard
        measuring.add(id);
        const kids = state.collapsed.has(id) ? [] : (childrenFn(id) || []);
        let w = coupleWidth(id);
        if (kids.length) {
          const childrenW = kids.reduce((s, k, i) => s + measure(k) + (i ? SIB_GAP : 0), 0);
          w = Math.max(w, childrenW);
        }
        measuring.delete(id);
        return (widthMemo[id] = w);
      }

      // Pass 2 — place each subtree in its band [left, left+w]; return card-pair centre.
      const placed = {}, placing = new Set();
      function place(id, left, depth) {
        if (id in placed) return placed[id];
        if (placing.has(id)) return left + coupleWidth(id) / 2;  // cycle guard
        placing.add(id);

        const w = measure(id);
        const cp = coParentOf(id);
        const kids = state.collapsed.has(id) ? [] : (childrenFn(id) || []);
        let center;

        if (!kids.length) {
          center = left + w / 2;
        } else {
          const childrenW = kids.reduce((s, k, i) => s + measure(k) + (i ? SIB_GAP : 0), 0);
          let cx = left + (w - childrenW) / 2;       // centre the children block in the band
          const cs = kids.map((k) => {
            const c = place(k, cx, depth + 1);
            cx += measure(k) + SIB_GAP;
            return c;
          });
          center = (cs[0] + cs[cs.length - 1]) / 2;
          const cw = coupleWidth(id);                 // keep couple inside band if children lopsided
          center = Math.min(Math.max(center, left + cw / 2), left + w - cw / 2);
        }

        const y = depth * GEN_H;
        if (cp) {
          pos[id]   = { x: center - HALF, y, depth };
          coPos[cp] = { x: center + HALF, y, depth };
        } else {
          pos[id] = { x: center, y, depth };
        }
        if (kids.length) families.push({ parents: cp ? [id, cp] : [id], children: kids.slice(), depth });

        placing.delete(id);
        return (placed[id] = center);
      }

      place(rootId, 0, 0);
      return { pos, coPos, families };
    }
    /* Build node + edge display lists from a focus graph. */
    function build(graph) {
      const cfg = state.viewCfg;
      const adj = buildAdjacency(graph);
      const rootId = graph.root.id;
      const childParents = graph.childParents || {};
      const coMarriage = graph.coMarriage || {};
      // people lookup (lineage + co-parents) -----------------------------------
      const personById = {};
      personById[rootId] = graph.root;
      graph.ancestors.nodes.forEach((v) => (personById[v.person.id] = v.person));
      graph.descendants.nodes.forEach((v) => (personById[v.person.id] = v.person));
      (graph.coParents || []).forEach((p) => (personById[p.id] = p));
      // choose one co-parent per lineage descendant node (Req 6) ---------------
      const lineageDesc = new Set([rootId]);
      graph.descendants.nodes.forEach((v) => lineageDesc.add(v.person.id));
      const usedCo = new Set();
      const coParentMemo = {};
      function coParentOf(id) {
        if (id in coParentMemo) return coParentMemo[id];
        const kids = adj.descChildren[id] || [];
        const tally = new Map();
        kids.forEach((c) => (childParents[c] || []).forEach((pp) => {
          if (pp !== id) tally.set(pp, (tally.get(pp) || 0) + 1);
        }));
        let best = null, bestN = -1;
        for (const [pid, n] of tally) {
          if (lineageDesc.has(pid)) continue; // don't fuse two lineage nodes into a couple
          if (usedCo.has(pid)) continue;
          if (!personById[pid]) continue;
          if (n > bestN) { bestN = n; best = pid; }
        }
        if (best) usedCo.add(best);
        coParentMemo[id] = best;
        return best;
      }
      const ancPos = layoutAncestors(rootId, (id) => adj.ancParents[id]);
      const desc = layoutDescendants(rootId, (id) => adj.descChildren[id], coParentOf);
      // align both halves so the root shares one x
      const dx = (ancPos[rootId].x || 0) - (desc.pos[rootId].x || 0);
      Object.values(desc.pos).forEach((p) => (p.x += dx));
      Object.values(desc.coPos).forEach((p) => (p.x += dx));
      // unified position map
      const positions = {};
      Object.assign(positions, desc.pos, desc.coPos, ancPos);
      const nodes = [];
      const edges = [];
      const drawn = new Set();
      function pushNode(id, x, y, kind, extra) {
        if (drawn.has(id)) return;
        drawn.add(id);
        const person = personById[id];
        const hasAnc = (id in state.ancestorMap)
          ? !!state.ancestorMap[id]
          : (adj.ancParents[id] || []).length > 0;
        // Prefer the data-layer descendant flag (so a co-parent / spouse / sibling
        // whose OTHER children were never loaded into the bounded graph is still
        // known to have children). Fall back to whatever is visible in-graph.
        const hasDesc = (id in state.descendantMap)
          ? !!state.descendantMap[id]
          : (adj.descChildren[id] || []).length > 0;
        // parent count drives the "add parent" affordance limitation. Prefer the
        // data-layer count; fall back to whatever parents are visible in-graph.
        const pcRaw = state.parentCounts ? state.parentCounts[id] : undefined;
        const parentCount = (pcRaw != null) ? pcRaw : (adj.ancParents[id] || []).length;
        nodes.push(Object.assign({
          id, person, x, y, kind,
          h: nodeHeight(person),
          hasAnc,
          hasDesc,
          parentCount,
          canAddParent: parentCount < 2,
          isRoot: id === rootId,
          collapsible: (hasAnc || hasDesc) && id !== rootId,
          collapsed: state.collapsed.has(id)
        }, extra || {}));
      }
      // lineage + co-parent nodes
      Object.keys(positions).forEach((id) => {
        if (!personById[id]) return;
        const isCo = (id in desc.coPos) && !(id in desc.pos) && !(id in ancPos);
        pushNode(id, positions[id].x, positions[id].y, isCo ? "coparent" : "lineage");
      });
      const posOf = (id) => positions[id];
      // ── ANCESTOR parent-pairs (Req 6) ───────────────────────────────────────
      // Group ancestor edges by child, draw a spouse link between the (shown)
      // parents and route a single trunk from the pair's midpoint to the child.
      const ancByChild = {};
      graph.ancestors.edges.forEach((e) => {
        if (!drawn.has(e.parent) || !drawn.has(e.child)) return;
        (ancByChild[e.child] = ancByChild[e.child] || []).push({ parent: e.parent, subtype: e.subtype });
      });
      Object.keys(ancByChild).forEach((childId) => {
        const ps = ancByChild[childId];
        const cpos = posOf(childId);
        const parentPositions = ps.map((p) => posOf(p.parent)).filter(Boolean);
        const mx = parentPositions.reduce((s, p) => s + p.x, 0) / parentPositions.length;
        const py = parentPositions[0].y;
        if (ps.length >= 2) {
          const a = posOf(ps[0].parent), b = posOf(ps[1].parent);
          edges.push({ kind: "spouse", pair: true, x1: a.x, y1: a.y, x2: b.x, y2: b.y,
            parent: ps[0].parent, parent2: ps[1].parent, marriage: coMarriage[[ps[0].parent, ps[1].parent].sort().join("|")] });
        }
        edges.push({ kind: "pc", x1: mx, y1: py, x2: cpos.x, y2: cpos.y,
          subtype: ps[0].subtype, parent: ps[0].parent, parent2: ps[1] && ps[1].parent, child: childId });
      });
      // ── DESCENDANT family units (Req 6) ─────────────────────────────────────
      desc.families.forEach((fam) => {
        const parentPositions = fam.parents.map(posOf).filter(Boolean);
        if (!parentPositions.length) return;
        const mx = parentPositions.reduce((s, p) => s + p.x, 0) / parentPositions.length;
        const py = parentPositions[0].y;
        if (fam.parents.length >= 2) {
          const a = posOf(fam.parents[0]), b = posOf(fam.parents[1]);
          edges.push({ kind: "spouse", pair: true, x1: a.x, y1: a.y, x2: b.x, y2: b.y,
            parent: fam.parents[0], parent2: fam.parents[1],
            marriage: coMarriage[[fam.parents[0], fam.parents[1]].sort().join("|")] });
        }
        fam.children.forEach((childId) => {
          const cpos = posOf(childId);
          if (!cpos) return;
          const sub = (childParents[childId] || []).length ? "biological" : "biological";
          edges.push({ kind: "pc", x1: mx, y1: py, x2: cpos.x, y2: cpos.y,
            subtype: sub, parent: fam.parents[0], parent2: fam.parents[1], child: childId });
        });
      });
      // ── Root's childless spouses (kept beside root) ─────────────────────────
      const rootP = positions[rootId];
      if (cfg.showSpouses) {
        let i = 0;
        graph.spouses.forEach((s) => {
          if (s.ex && !cfg.showEx) return;
          if (drawn.has(s.person.id)) return; // already shown as a co-parent
          personById[s.person.id] = s.person;
          const x = rootP.x + (++i) * (NODE_W + COUPLE_GAP);
          pushNode(s.person.id, x, 0, "spouse", { ex: s.ex, marriage: s.marriage });
          edges.push({ kind: "spouse", pair: true, ex: s.ex, x1: rootP.x, y1: 0, x2: x, y2: 0,
            parent: rootId, parent2: s.person.id, marriage: s.marriage });
        });
      }
      // ── Siblings of the root ────────────────────────────────────────────────
      // ⚠️ ACCEPTANCE CRITERIA: siblings must NEVER be connected directly to one
      // another. Every sibling is connected ONLY through their shared parent(s).
      // We therefore route each sibling's connector up to the SAME parent-pair
      // midpoint the root descends from, so the whole sibling group hangs off a
      // single shared "bus" beneath the common parents — exactly like any other
      // set of children. If no parent is currently shown, we draw NO connector
      // at all (a stray sibling card is acceptable; a sibling-to-sibling line is
      // not).
      const rootParents = (adj.ancParents[rootId] || []).filter((pid) => drawn.has(pid));
      let rootParentMid = null, rootParentY = null;
      if (rootParents.length) {
        const pps = rootParents.map(posOf).filter(Boolean);
        if (pps.length) {
          rootParentMid = pps.reduce((s, p) => s + p.x, 0) / pps.length;
          rootParentY = pps[0].y;
        }
      }
      if (cfg.showSiblings) {
        let i = 0;
        graph.siblings.forEach((s) => {
          if (s.half && !cfg.showHalf) return;
          if (drawn.has(s.person.id)) return;
          personById[s.person.id] = s.person;
          const x = rootP.x - (++i) * (NODE_W + SIB_GAP);
          pushNode(s.person.id, x, 0, "sibling", { half: s.half });
          // Connect through the shared parent pair ONLY (no sibling-to-sibling).
          if (rootParentMid != null) {
            edges.push({ kind: "pc", siblingLink: true, half: s.half,
              x1: rootParentMid, y1: rootParentY, x2: x, y2: 0,
              subtype: s.half ? "half" : "biological",
              parent: rootParents[0], parent2: rootParents[1], child: s.person.id });
          }
        });
      }
      // ── Parent-expansion / hidden-relative flags ────────────────────────────
      // For every drawn card, work out which parents/children are already on
      // screen so we can decide whether to offer a "go to my parents" affordance.
      const hasDrawnParent = new Set();
      const hasDrawnChild = new Set();
      edges.forEach((e) => {
        if (e.kind !== "pc" || !e.child) return;
        hasDrawnParent.add(e.child);            // this child has a parent on screen
        if (e.parent)  hasDrawnChild.add(e.parent);   // these parents have a child on screen
        if (e.parent2) hasDrawnChild.add(e.parent2);
      });
      nodes.forEach((n) => {
        // A person has "hidden parents" when they have parent records that are
        // NOT currently drawn on screen. EVERY card kind (lineage, root, spouse,
        // co-parent, sibling) that has hidden parents now shows the SAME small
        // parent tab on its top edge — see showParentNav below.
        const hasHiddenParents = !!n.hasAnc && !hasDrawnParent.has(n.id);
        // Behaviour only (NOT visual): lineage / root reveal their hidden parents
        // IN PLACE (the ancestor walk extends from the root); every other kind
        // re-centres the tree on that person to bring their parents into view.
        // canExpandParents picks the behaviour; the icon itself is identical.
        n.canExpandParents = hasHiddenParents && (n.isRoot || n.kind === "lineage");
        // ── Hidden-relative navigation tabs ───────────────────────────
        // TOP edge tab when the person has parents not on screen; BOTTOM edge
        // tab when they have children not on screen. The TOP tab now appears on
        // ALL card kinds (it is no longer suppressed on lineage / root), so the
        // SAME parent icon is shown for every person.
        n.showParentNav = hasHiddenParents;
        n.showChildNav  = !!n.hasDesc && !hasDrawnChild.has(n.id);
      });
      // Record which side each node's spouse connector is on (from the spouse
      // edges) so the on-card "add spouse" control sits on the OPPOSITE side
      // from the existing link.
      const nodeIndex = {};
      nodes.forEach((n) => (nodeIndex[n.id] = n));
      edges.forEach((e) => {
        if (e.kind !== "spouse") return;
        const aN = nodeIndex[e.parent], bN = nodeIndex[e.parent2];
        if (aN && bN) {
          aN.spouseSide = bN.x > aN.x ? "right" : "left";
          bN.spouseSide = aN.x > bN.x ? "right" : "left";
        }
      });
      state.nodes = nodes;
      state.edges = edges;
    }
    /* ------------------------------ render ------------------------------ */
    function render(graph, viewCfg, extra) {
      if (!graph) return;
      state.graph = graph;
      if (extra && extra.ancestorMap) state.ancestorMap = extra.ancestorMap;
      if (extra && extra.descendantMap) state.descendantMap = extra.descendantMap;
      if (extra && extra.parentCounts) state.parentCounts = extra.parentCounts;
      if (extra && extra.childCounts) state.childCounts = extra.childCounts;
      if (viewCfg) state.viewCfg = Object.assign(state.viewCfg, viewCfg);
      build(graph);
      const changedRoot = state.lastRoot !== graph.root.id;
      const firstRender = state.lastRoot == null;
      const rootVisible = state.nodes.some((n) => n.id === graph.root.id) && !firstRender;
      if (!opts.keepView && (firstRender || (changedRoot && !rootVisible))) {
        // Smoothly pan/zoom to the new branch on navigation; snap on first load.
        fit(!firstRender);
      }
      state.lastRoot = graph.root.id;
      if (state.selectedId && !state.nodes.some((n) => n.id === state.selectedId)) {
        // keep the panel's person even if they scrolled out of the bounded graph
        // (Req 7: navigation should not lose the current selection context).
      }
      draw();
    }
    function rerender() { if (state.graph) { build(state.graph); draw(); } }
    // ✅ ADDED: collapse/expand toggle used by click + keyboard + touch.
    function toggleCollapse(id) {
      if (state.collapsed.has(id)) state.collapsed.delete(id);
      else state.collapsed.add(id);
      rerender();
    }
    // Req 4: select a node — highlight it and push it to the side editor panel.
    function selectNode(id) {
      state.selectedId = id;
      draw();
      state.onSelect(id);
    }
    // Req 7: navigate up — re-centre the tree on this person's branch.
    function navigateTo(id) {
      state.onNavigate(id);
    }
    // Route a hit-test result to the correct action.
    function activateHit(hit) {
      if (!hit) return;
      if (hit.expand) {
        // Reveal this card's hidden parents in place (no full tree reset).
        state.onExpandParents(hit.node.id);
        state.onAnnounce("Revealing parents of " + M.fullName(hit.node.person));
      } else if (hit.addParent) {
        if (hit.side) filledParentSide.set(hit.node.id, hit.side);   // remember which slot was used
        state.onAddRelative(hit.node.id, "parent");
      } else if (hit.addChild) {
        state.onAddRelative(hit.node.id, "child");
      } else if (hit.addSpouse) {
        state.onAddRelative(hit.node.id, "spouse");
      } else if (hit.navigate) {
        // Switch the whole view to this person (same as double-clicking the
        // card) so their now-hidden parents / children come into view.
        state.onAnnounce("Centering on " + M.fullName(hit.node.person));
        navigateTo(hit.node.id);
      } else {
        selectNode(hit.node.id);
      }
    }
    /* ------------------------------ drawing ------------------------------ */
    function nodeRect(n) {
      const h = n.h || NODE_H1;
      return { x: n.x - NODE_W / 2, y: n.y - h / 2, w: NODE_W, h };
    }
    // ── On-card quick-add controls ───────────────────────────────────────────
    // Parent controls on the TOP edge: TWO slots placed left and right of the
    // top-center connector. Both show when the person has no parents yet; one
    // remains once a single parent is on record (the filled slot's button is
    // gone and that parent is connected); none once both parents exist
    // (parentCount >= 2) — at which point the parent-pair link at the card's
    // top-center is all that's shown. Child CENTERED on the BOTTOM edge; spouse
    // CENTERED on a SIDE edge.
    const ADD_PARENT_DX = 20;   // offset of each parent slot from top-center (≈¼ / ¾ of card width)
    // Remembers which top slot a person's first parent was added from (via an
    // on-card click), so the remaining "+" stays in the OTHER (still-empty)
    // slot instead of jumping sides. Per-renderer-instance; resets on reload.
    const filledParentSide = new Map();   // personId -> "L" | "R"
    function addParentSlots(n) {
      const r = nodeRect(n);
      const cx = r.x + r.w / 2, y = r.y;
      const L = { x: cx - ADD_PARENT_DX, y: y, side: "L" };
      const R = { x: cx + ADD_PARENT_DX, y: y, side: "R" };
      const pc = n.parentCount || 0;
      if (pc >= 2) return [];                       // both parents set — no buttons
      if (pc === 1) {                               // one parent set — keep the empty slot's button
        const filled = filledParentSide.get(n.id);
        if (filled === "L") return [R];             // left slot used -> right remains
        if (filled === "R") return [L];             // right slot used -> left remains
        return [R];                                 // unknown source (reload/import/panel) -> default right
      }
      return [L, R];                                // no parents — both slots
    }
    // Child control centered on the bottom edge.
    function addChildCenter(n)  { const r = nodeRect(n); return { x: r.x + r.w / 2, y: r.y + r.h }; }
    // Spouse control centered on a side edge, on the OPPOSITE side from this
    // card's existing spouse connector (so the "+" never sits on the spouse
    // link). Default to the right edge; flip to the left edge when the spouse
    // link is on the right.
    function addSpouseCenter(n) {
      const r = nodeRect(n);
      if (n.spouseSide === "right") return { x: r.x, y: r.y + r.h / 2 };
      return { x: r.x + r.w, y: r.y + r.h / 2 };
    }
    function roundRect(ctx, x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }
    function truncate(ctx, text, maxW) {
      if (ctx.measureText(text).width <= maxW) return text;
      while (text.length > 1 && ctx.measureText(text + "\u2026").width > maxW) {
        text = text.slice(0, -1);
      }
      return text + "\u2026";
    }
    // Draw a small circular "+" control (used by all three add affordances).
    function drawAddControl(ctx, c) {
      ctx.beginPath();
      ctx.arc(c.x, c.y, ADD_R, 0, Math.PI * 2);
      ctx.fillStyle = C.badgeFill; ctx.fill();
      ctx.lineWidth = 1.3; ctx.strokeStyle = C.add; ctx.stroke();
      ctx.strokeStyle = C.add; ctx.lineWidth = 1.7; ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(c.x - 3.6, c.y); ctx.lineTo(c.x + 3.6, c.y);
      ctx.moveTo(c.x, c.y - 3.6); ctx.lineTo(c.x, c.y + 3.6);
      ctx.stroke();
      ctx.lineCap = "butt";
    }
    // ── Hidden-relative navigation tabs ──────────────────────────────────────
    // Geometry for the small rectangle attached to a card edge. The TOP tab
    // (parents) is centred just above the card; the BOTTOM tab (children) sits
    // just below the card's "add child" (+) control so the two never collide.
    function parentNavTab(n) {
      const r = nodeRect(n);
      const cx = r.x + r.w / 2;
      return { x: cx - NAV_W / 2, y: r.y - NAV_GAP_TOP - NAV_H, w: NAV_W, h: NAV_H,
               cx, edgeY: r.y, dir: "up" };
    }
    function childNavTab(n) {
      const r = nodeRect(n);
      const cx = r.x + r.w / 2;
      const top = r.y + r.h + ADD_R + NAV_GAP_BOTTOM;   // clear the bottom "+" control
      return { x: cx - NAV_W / 2, y: top, w: NAV_W, h: NAV_H,
               cx, edgeY: r.y + r.h + ADD_R, dir: "down" };
    }
    // Render a nav tab: a short connector stub from the card, a rounded
    // rectangle, and a directional chevron (▲ parents / ▼ children).
    function drawNavTab(ctx, t) {
      ctx.strokeStyle = C.edge; ctx.lineWidth = 1.4;
      ctx.beginPath();
      if (t.dir === "up") { ctx.moveTo(t.cx, t.edgeY); ctx.lineTo(t.cx, t.y + t.h); }
      else                { ctx.moveTo(t.cx, t.edgeY); ctx.lineTo(t.cx, t.y); }
      ctx.stroke();
      roundRect(ctx, t.x, t.y, t.w, t.h, 3);
      // Parent / expand tab (▲): a plain, slightly darker filled nub with NO
      // chevron. Child tab (▼) keeps the light badge fill + down chevron.
      if (t.dir === "up") {
        ctx.fillStyle = C.navFill; ctx.fill();
        ctx.lineWidth = 1.3; ctx.strokeStyle = C.spouse; ctx.stroke();
        return;                              // no glyph on the expand tab
      }
      ctx.fillStyle = C.badgeFill; ctx.fill();
      ctx.lineWidth = 1.3; ctx.strokeStyle = C.spouse; ctx.stroke();
      const mx = t.cx, my = t.y + t.h / 2;
      ctx.strokeStyle = C.ink; ctx.lineWidth = 1.5;
      ctx.lineCap = "round"; ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(mx - 4, my - 2); ctx.lineTo(mx, my + 2); ctx.lineTo(mx + 4, my - 2);
      ctx.stroke();
      ctx.lineCap = "butt";
    }
    function draw() {
      const ctx = state.ctx;
      if (!ctx) return;
      const { dpr, t } = state;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, state.canvas.width, state.canvas.height);
      ctx.setTransform(dpr * t.k, 0, 0, dpr * t.k, dpr * t.x, dpr * t.y);
      const hl = state.hoverId || state.selectedId;
      const touches = (e) => hl && (e.parent === hl || e.parent2 === hl || e.child === hl);
      // edges first
      for (const e of state.edges) {
        const isHl = touches(e);
        ctx.lineWidth = isHl ? 2.6 : 1.6;
        ctx.strokeStyle = isHl ? C.edgeHl : (e.kind === "pc" ? C.edge : C.spouse);
        if (e.kind === "spouse") {
          // Spouse / partner link drawn as a clear horizontal connector between
          // the pair; dashed when the relationship ended (Req 6).
          const ex = e.ex || (e.marriage && e.marriage.divorce_date);
          ctx.setLineDash(ex ? [6, 5] : []);
          if (ex) {
            ctx.beginPath();
            ctx.moveTo(e.x1, e.y1); ctx.lineTo(e.x2, e.y2); ctx.stroke();
          } else {
            // double hair-line = "married/partnered" family bond
            ctx.beginPath();
            ctx.moveTo(e.x1, e.y1 - 2); ctx.lineTo(e.x2, e.y2 - 2);
            ctx.moveTo(e.x1, e.y1 + 2); ctx.lineTo(e.x2, e.y2 + 2);
            ctx.stroke();
          }
          ctx.setLineDash([]);
          continue;
        }
        ctx.setLineDash(
          e.half ? [5, 4] :
          e.subtype === "adoptive" ? [7, 4] :
          e.subtype === "step" || e.subtype === "foster" || e.subtype === "guardian" ? [3, 4] :
          e.subtype === "unknown" ? [1, 4] : []
        );
        ctx.beginPath();
        if (e.kind === "pc") {
          // Trunk from the parent-pair midpoint down to a shared "bus", then to
          // the child — siblings share the bus so they read as one family.
          const my = (e.y1 + e.y2) / 2;
          ctx.moveTo(e.x1, e.y1);
          ctx.lineTo(e.x1, my);
          ctx.lineTo(e.x2, my);
          ctx.lineTo(e.x2, e.y2);
        } else {
          ctx.moveTo(e.x1, e.y1);
          ctx.lineTo(e.x2, e.y2);
        }
        ctx.stroke();
      }
      ctx.setLineDash([]);
      // nodes
      for (const n of state.nodes) {
        const r = nodeRect(n);
        const pal = n.person.gender === "male" ? C.male
          : n.person.gender === "female" ? C.female : C.neutral;
        ctx.save();
        ctx.shadowColor = C.shadow;
        ctx.shadowBlur = 6;
        ctx.shadowOffsetY = 2;
        ctx.fillStyle = pal.fill;
        roundRect(ctx, r.x, r.y, r.w, r.h, 8);
        ctx.fill();
        ctx.restore();
        ctx.lineWidth = n.isRoot ? 2.6 : 1.4;
        ctx.strokeStyle = n.isRoot ? C.rootRing : pal.stroke;
        roundRect(ctx, r.x, r.y, r.w, r.h, 8);
        ctx.stroke();
        if (n.id === state.selectedId) {
          ctx.lineWidth = 2;
          ctx.strokeStyle = C.selRing;
          ctx.setLineDash([4, 3]);
          roundRect(ctx, r.x - 4, r.y - 4, r.w + 8, r.h + 8, 10);
          ctx.stroke();
          ctx.setLineDash([]);
        } else if (n.id === state.hoverId) {
          ctx.lineWidth = 2.2;
          ctx.strokeStyle = C.selRing;
          roundRect(ctx, r.x, r.y, r.w, r.h, 8);
          ctx.stroke();
        }
        // ── Centered, two-line name + lifespan (Req 2 & 3) ──────────────
        const cx = r.x + r.w / 2;
        const lines = M.displayLines(n.person);
        const sub = M.lifeSpan(n.person) || (n.person.living ? "living" : "");
        const tag = n.kind === "spouse" ? (n.ex ? "former spouse" : "spouse")
          : n.kind === "coparent" ? "spouse"
          : n.kind === "sibling" ? (n.half ? "half-sibling" : "sibling") : "";
        const subtitle = [sub, tag].filter(Boolean).join(" \u00b7 ");
        ctx.textAlign = "center";
        ctx.fillStyle = C.ink;
        ctx.textBaseline = "alphabetic";
        const maxW = r.w - (ANC_R * 2 + 16);
        const maxWtop = r.w - 2 * (ANC_R * 2 + 10);   // first line keeps clear of the top-edge controls
        if (lines.line2) {
          ctx.font = "600 13px 'Spline Sans', system-ui, sans-serif";
          ctx.fillText(truncate(ctx, lines.line1, maxWtop), cx, r.y + 22);
          ctx.font = "500 12px 'Spline Sans', system-ui, sans-serif";
          ctx.fillStyle = C.inkSoft;
          ctx.fillText(truncate(ctx, lines.line2, maxW), cx, r.y + 38);
          ctx.fillStyle = C.inkSoft;
          ctx.font = "400 11px 'Spline Sans', system-ui, sans-serif";
          ctx.fillText(truncate(ctx, subtitle, maxW), cx, r.y + 56);
        } else {
          ctx.font = "600 13px 'Spline Sans', system-ui, sans-serif";
          ctx.fillText(truncate(ctx, lines.line1, maxWtop), cx, r.y + 23);
          ctx.fillStyle = C.inkSoft;
          ctx.font = "400 11px 'Spline Sans', system-ui, sans-serif";
          ctx.fillText(truncate(ctx, subtitle, maxW), cx, r.y + 41);
        }
        ctx.textAlign = "left";
        // ── Hidden-relative navigation tabs ─────────────────────────────
        // The SAME small parent tab is drawn on EVERY card kind that has
        // parents off-screen (lineage / root / spouse / co-parent / sibling);
        // the bottom tab marks hidden children. The click behaviour
        // (reveal-in-place vs re-centre) is decided in hitTest via
        // n.canExpandParents — the icon itself is identical for everyone.
        if (n.showParentNav) drawNavTab(ctx, parentNavTab(n));
        if (n.showChildNav)  drawNavTab(ctx, childNavTab(n));
        // ── On-card quick-add controls (parent slots ▲ top, child ▼ bottom, spouse ▶ side)
        // Parent slots respect the limitation: two when childless of parents,
        // one after the first parent, none once both exist.
        addParentSlots(n).forEach((c) => drawAddControl(ctx, c));
        drawAddControl(ctx, addChildCenter(n));
        drawAddControl(ctx, addSpouseCenter(n));
      }
    }
    /* ----------------------------- hit testing ----------------------------- */
    function hitTest(sx, sy) {
      const w = screenToWorld(sx, sy);
      for (let i = state.nodes.length - 1; i >= 0; i--) {
        const n = state.nodes[i];
        // ── on-card quick-add controls (checked before the body so the edge
        //    buttons win over a plain node select) ─────────────────────────
        for (const c of addParentSlots(n)) {
          const dx = w.x - c.x, dy = w.y - c.y;
          if (dx * dx + dy * dy <= (ADD_R + 3) * (ADD_R + 3)) return { node: n, addParent: true, side: c.side };
        }
        {
          const c = addChildCenter(n);
          const dx = w.x - c.x, dy = w.y - c.y;
          if (dx * dx + dy * dy <= (ADD_R + 3) * (ADD_R + 3)) return { node: n, addChild: true };
        }
        {
          const c = addSpouseCenter(n);
          const dx = w.x - c.x, dy = w.y - c.y;
          if (dx * dx + dy * dy <= (ADD_R + 3) * (ADD_R + 3)) return { node: n, addSpouse: true };
        }
        // hidden-relative navigation tabs (rectangular hit areas)
        if (n.showParentNav) {
          const t = parentNavTab(n);
          if (w.x >= t.x && w.x <= t.x + t.w && w.y >= t.y && w.y <= t.y + t.h)
            // lineage / root reveal their parents IN PLACE; every other card
            // kind re-centres the tree on that person.
            return n.canExpandParents ? { node: n, expand: true } : { node: n, navigate: true };
        }
        if (n.showChildNav) {
          const t = childNavTab(n);
          if (w.x >= t.x && w.x <= t.x + t.w && w.y >= t.y && w.y <= t.y + t.h) return { node: n, navigate: true };
        }
        const r = nodeRect(n);
        if (w.x >= r.x && w.x <= r.x + r.w && w.y >= r.y && w.y <= r.y + r.h) return { node: n };
      }
      return null;
    }
    /* ------------------------------ view ops ------------------------------ */
    function cancelAnim() { if (animRAF) { cancelAnimationFrame(animRAF); animRAF = null; } }
    function animateTo(target, ms) {
      cancelAnim();
      const start = { x: state.t.x, y: state.t.y, k: state.t.k };
      const t0 = performance.now();
      ms = ms || 420;
      function step(now) {
        const u = Math.min(1, (now - t0) / ms);
        const e = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2; // easeInOutQuad
        state.t.x = start.x + (target.x - start.x) * e;
        state.t.y = start.y + (target.y - start.y) * e;
        state.t.k = start.k + (target.k - start.k) * e;
        draw();
        if (u < 1) animRAF = requestAnimationFrame(step); else animRAF = null;
      }
      animRAF = requestAnimationFrame(step);
    }
    function fit(animate) {
      cancelAnim();
      if (!state.nodes.length) { state.t = { x: 0, y: 0, k: 1 }; return; }
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      state.nodes.forEach((n) => {
        const r = nodeRect(n);
        minX = Math.min(minX, r.x); minY = Math.min(minY, r.y);
        maxX = Math.max(maxX, r.x + r.w); maxY = Math.max(maxY, r.y + r.h);
      });
      const pad = 60;
      const cw = state.canvas.width / state.dpr, chh = state.canvas.height / state.dpr;
      const k = Math.min(cw / (maxX - minX + pad * 2), chh / (maxY - minY + pad * 2), 1.6);
      const target = {
        k: Math.max(0.08, k),
        x: cw / 2 - ((minX + maxX) / 2) * Math.max(0.08, k),
        y: chh / 2 - ((minY + maxY) / 2) * Math.max(0.08, k)
      };
      if (animate) animateTo(target);
      else { state.t = target; draw(); }
    }
    function zoom(factor, sx, sy) {
      const cw = state.canvas.width / state.dpr, chh = state.canvas.height / state.dpr;
      if (sx == null) { sx = cw / 2; sy = chh / 2; }
      const before = screenToWorld(sx, sy);
      state.t.k = Math.min(4, Math.max(0.08, state.t.k * factor));
      state.t.x = sx - before.x * state.t.k;
      state.t.y = sy - before.y * state.t.k;
      draw();
    }
    // Pan just enough to bring a node comfortably into view (keyboard nav).
    function ensureVisible(n) {
      const cw = state.canvas.width / state.dpr, chh = state.canvas.height / state.dpr;
      const sx = n.x * state.t.k + state.t.x, sy = n.y * state.t.k + state.t.y;
      const pad = 90;
      let moved = false;
      if (sx < pad) { state.t.x += (pad - sx); moved = true; }
      else if (sx > cw - pad) { state.t.x -= (sx - (cw - pad)); moved = true; }
      if (sy < pad) { state.t.y += (pad - sy); moved = true; }
      else if (sy > chh - pad) { state.t.y -= (sy - (chh - pad)); moved = true; }
      if (moved) draw();
    }
    /* --------------------------- keyboard helpers --------------------------- */
    function nodeById(id) { return state.nodes.find((n) => n.id === id) || null; }
    function announceNode(n) {
      if (!n) return;
      const span = M.lifeSpan(n.person) || (n.person.living ? "living" : "");
      state.onAnnounce(M.fullName(n.person) + (span ? ", " + span : ""));
    }
    // Move the selection geometrically in a direction (dx/dy are -1, 0, or 1).
    function moveSelection(dx, dy) {
      const cur = nodeById(state.selectedId)
        || state.nodes.find((n) => n.isRoot)
        || state.nodes[0];
      if (!cur) return;
      let best = null, bestScore = Infinity;
      for (const n of state.nodes) {
        if (n.id === cur.id) continue;
        const ox = n.x - cur.x, oy = n.y - cur.y;
        if (dx !== 0) {
          if (Math.sign(ox) !== Math.sign(dx)) continue;       // wrong side
          if (Math.abs(ox) < Math.abs(oy)) continue;           // mostly vertical
        }
        if (dy !== 0) {
          if (Math.sign(oy) !== Math.sign(dy)) continue;
          if (Math.abs(oy) < Math.abs(ox)) continue;           // mostly horizontal
        }
        const score = Math.abs(ox) + Math.abs(oy);
        if (score < bestScore) { bestScore = score; best = n; }
      }
      if (best) {
        state.selectedId = best.id;
        draw();
        ensureVisible(best);
        announceNode(best);
        state.onSelect(best.id);   // Req 4: keep the side panel in sync
      }
    }
    /* ---------------------------- interactions ---------------------------- */
    function bindInteractions() {
      const canvas = state.canvas;
      // ✅ Wheel zoom: compute the rect inside the handler (was undefined).
      wheelHandler = (e) => {
        e.preventDefault();
        const rect = canvas.getBoundingClientRect();
        zoom(e.deltaY > 0 ? 0.89 : 1.12, e.clientX - rect.left, e.clientY - rect.top);
      };
      canvas.addEventListener("wheel", wheelHandler, { passive: false });
      mouseDownHandler = (e) => {
        state.drag = { sx: e.clientX, sy: e.clientY, tx: state.t.x, ty: state.t.y };
        state.didDrag = false;
      };
      canvas.addEventListener("mousedown", mouseDownHandler);
      mouseMoveHandler = (e) => {
        if (state.drag) {
          const dx = e.clientX - state.drag.sx, dy = e.clientY - state.drag.sy;
          if (Math.abs(dx) + Math.abs(dy) > 4) state.didDrag = true;
          if (state.didDrag) { state.t.x = state.drag.tx + dx; state.t.y = state.drag.ty + dy; canvas.classList.add("grabbing"); draw(); }
          return;
        }
        const rect = canvas.getBoundingClientRect();
        if (e.target !== canvas) return;
        const hit = hitTest(e.clientX - rect.left, e.clientY - rect.top);
        canvas.style.cursor = hit ? "pointer" : "grab";
        if (hit && hit.node) {
          const id = hit.node.id;
          if (id !== state.hoverId) { state.hoverId = id; draw(); }
        } else if (state.hoverId !== null) { state.hoverId = null; draw(); }
      };
      mouseUpHandler = (e) => {
        const wasDrag = state.didDrag;
        canvas.classList.remove("grabbing");
        if (state.drag && !wasDrag && e.target === canvas) {
          const rect = canvas.getBoundingClientRect();
          const hit = hitTest(e.clientX - rect.left, e.clientY - rect.top);
          if (hit) activateHit(hit);
        }
        state.drag = null;
        state.didDrag = false;
      };
      window.addEventListener("mousemove", mouseMoveHandler);
      window.addEventListener("mouseup", mouseUpHandler);
      // Double-click a card to focus / re-centre the tree on that person
      // (replaces the old top-left ancestor triangle). Ignores the on-card
      // controls so a double-click on a "+" doesn't re-centre.
      dblHandler = (e) => {
        if (e.target !== canvas) return;
        const rect = canvas.getBoundingClientRect();
        const hit = hitTest(e.clientX - rect.left, e.clientY - rect.top);
        if (hit && hit.node && !hit.expand && !hit.addParent && !hit.addChild && !hit.addSpouse && !hit.navigate) {
          e.preventDefault();
          navigateTo(hit.node.id);
        }
      };
      canvas.addEventListener("dblclick", dblHandler);
      // ✅ Keyboard navigation (bound to the focusable canvas).
      keyHandler = (e) => {
        switch (e.key) {
          case "ArrowUp": e.preventDefault(); moveSelection(0, -1); break;
          case "ArrowDown": e.preventDefault(); moveSelection(0, 1); break;
          case "ArrowLeft": e.preventDefault(); moveSelection(-1, 0); break;
          case "ArrowRight": e.preventDefault(); moveSelection(1, 0); break;
          case "Enter":
            e.preventDefault();
            if (state.selectedId) navigateTo(state.selectedId);
            break;
          case "+": case "=": e.preventDefault(); zoom(1.18); break;
          case "-": case "_": e.preventDefault(); zoom(0.85); break;
          case "0": e.preventDefault(); fit(); break;
          case " ": {
            e.preventDefault();
            const n = nodeById(state.selectedId);
            if (n && n.collapsible) {
              toggleCollapse(n.id);
              state.onAnnounce((state.collapsed.has(n.id) ? "Collapsed " : "Expanded ") + M.fullName(n.person));
            }
            break;
          }
          default: return;
        }
      };
      canvas.addEventListener("keydown", keyHandler);
      // ✅ Touch: one-finger pan + tap, two-finger pinch zoom.
      function tdist(touches) {
        const a = touches[0], b = touches[1];
        return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      }
      touchStartHandler = (e) => {
        if (e.touches.length === 1) {
          touch.mode = "pan";
          touch.lastX = e.touches[0].clientX;
          touch.lastY = e.touches[0].clientY;
          touch.moved = false;
        } else if (e.touches.length === 2) {
          touch.mode = "pinch";
          touch.startDist = tdist(e.touches) || 1;
          touch.startK = state.t.k;
        }
      };
      touchMoveHandler = (e) => {
        if (touch.mode === "pan" && e.touches.length === 1) {
          e.preventDefault();
          const dx = e.touches[0].clientX - touch.lastX;
          const dy = e.touches[0].clientY - touch.lastY;
          if (Math.abs(dx) + Math.abs(dy) > 4) touch.moved = true;
          state.t.x += dx; state.t.y += dy;
          touch.lastX = e.touches[0].clientX;
          touch.lastY = e.touches[0].clientY;
          draw();
        } else if (touch.mode === "pinch" && e.touches.length === 2) {
          e.preventDefault();
          const rect = canvas.getBoundingClientRect();
          const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left;
          const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top;
          const targetK = touch.startK * (tdist(e.touches) / touch.startDist);
          zoom(targetK / state.t.k, cx, cy);
        }
      };
      touchEndHandler = (e) => {
        if (touch.mode === "pan" && !touch.moved && e.changedTouches.length) {
          const rect = canvas.getBoundingClientRect();
          const tx = e.changedTouches[0].clientX, ty = e.changedTouches[0].clientY;
          const hit = hitTest(tx - rect.left, ty - rect.top);
          if (hit) activateHit(hit);
          // Double-tap a card body to focus / re-centre (mirrors mouse dblclick).
          const isBody = hit && hit.node && !hit.expand && !hit.addParent && !hit.addChild && !hit.addSpouse && !hit.navigate;
          const now = Date.now();
          if (isBody && touch.lastTapAt && (now - touch.lastTapAt) < 320 &&
              Math.abs(tx - touch.lastTapX) < 24 && Math.abs(ty - touch.lastTapY) < 24) {
            navigateTo(hit.node.id);
            touch.lastTapAt = 0;
          } else {
            touch.lastTapAt = now; touch.lastTapX = tx; touch.lastTapY = ty;
          }
        }
        if (e.touches.length === 0) touch.mode = null;
      };
      canvas.addEventListener("touchstart", touchStartHandler, { passive: false });
      canvas.addEventListener("touchmove", touchMoveHandler, { passive: false });
      canvas.addEventListener("touchend", touchEndHandler);
    }
    // ✅ Cleanup: actually removes every listener this renderer registered.
    function destroy() {
      cancelAnim();
      if (resizeObserver) { try { resizeObserver.disconnect(); } catch (_) {} resizeObserver = null; }
      window.removeEventListener("resize", resize);
      window.removeEventListener("mousemove", mouseMoveHandler);
      window.removeEventListener("mouseup", mouseUpHandler);
      const c = state.canvas;
      if (c) {
        c.removeEventListener("wheel", wheelHandler);
        c.removeEventListener("mousedown", mouseDownHandler);
        c.removeEventListener("dblclick", dblHandler);
        c.removeEventListener("keydown", keyHandler);
        c.removeEventListener("touchstart", touchStartHandler);
        c.removeEventListener("touchmove", touchMoveHandler);
        c.removeEventListener("touchend", touchEndHandler);
      }
    }
    init();
    return {
      render, fit, zoomIn: () => zoom(1.18), zoomOut: () => zoom(0.85), reset: () => fit(true),
      expandAll: () => { state.collapsed.clear(); rerender(); },
      collapse: (id) => toggleCollapse(id),
      select: (id) => { state.selectedId = id; draw(); },
      setOnSelect: (cb) => (state.onSelect = cb || function () {}),
      setOnNavigate: (cb) => (state.onNavigate = cb || function () {}),
      setOnFocus: (cb) => (state.onNavigate = cb || function () {}), // back-compat alias
      setOnExpandParents: (cb) => (state.onExpandParents = cb || function () {}),
      setOnAddRelative: (cb) => (state.onAddRelative = cb || function () {}),
      setOnAnnounce: (cb) => (state.onAnnounce = cb),
      setViewCfg: (cfg) => { state.viewCfg = Object.assign(state.viewCfg, cfg); rerender(); },
      getView: () => ({ x: state.t.x, y: state.t.y, k: state.t.k }),
      setView: (v) => { if (v && isFinite(v.k)) { state.t = { x: v.x, y: v.y, k: v.k }; draw(); } },
      resize, destroy
    };
  }
  FT.TreeRenderer = { create };
})(window.FT);
