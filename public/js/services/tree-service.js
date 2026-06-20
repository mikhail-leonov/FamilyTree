/* ============================================================================
 * services/tree-service.js
 * Focus-mode graph assembly. Given a focus person, walks the parent-child
 * graph upward (ancestors) and downward (descendants) to a configurable depth,
 * plus sideways relations (siblings, half-siblings, spouses, ex-spouses).
 * Only the bounded neighbourhood is ever loaded — never the whole dataset.
 * ========================================================================== */
window.FT = window.FT || {};

(function (FT) {
  "use strict";
  const DB = FT.DB, Data = FT.Data, M = FT.Models;

  async function person(id) { return DB.get("persons", id); }

  /* ✅ ADDED (Req 7): does this person have at least one parent edge? */
  async function hasParents(id) {
    const edges = await Data.Relationships.parentsOf(id);
    return edges.length > 0;
  }

  /* ✅ ADDED (Req 7): bulk "does X have ancestors" lookup for a set of ids.
   * Returns a plain object id->boolean so the renderer can draw the correct
   * ancestor indicator on every node, even nodes at the loaded frontier whose
   * parents are NOT themselves part of the bounded graph. */
  async function ancestorFlags(ids) {
    const out = {};
    for (const id of ids) {
      const edges = await Data.Relationships.parentsOf(id);
      out[id] = edges.length > 0;
    }
    return out;
  }

  /* Collect ancestors up to maxDepth. Returns { nodes:Map(id->person@depth), edges:[] }
   *
   * `expanded` is an optional Set of person ids the user has INDIVIDUALLY asked
   * to reveal (by clicking that one card's parent tab). A node in this set may
   * walk ONE generation past maxDepth, so clicking a person's parent tab pulls
   * in only THAT person's parents — not every other frontier node sharing the
   * same generation. */
  async function ancestors(rootId, maxDepth, expanded) {
    expanded = expanded || new Set();
    const nodes = new Map();
    const edges = [];
    const queue = [{ id: rootId, depth: 0 }];
    const visited = new Set();
    while (queue.length) {
      const { id, depth } = queue.shift();
      if (visited.has(id)) continue;
      visited.add(id);
      // Stop at the depth limit UNLESS this exact person was individually
      // expanded by the user. Their freshly-revealed parents land at depth+1
      // and (not being expanded themselves) stop there, so the reveal grows by
      // a single generation above the clicked person only.
      if (depth >= maxDepth && !expanded.has(id)) continue;
      const parentEdges = await Data.Relationships.parentsOf(id);
      for (const e of parentEdges) {
        edges.push({ parent: e.parent_id, child: e.child_id, subtype: e.subtype });
        const p = await person(e.parent_id);
        if (p && !nodes.has(p.id)) nodes.set(p.id, { person: p, depth: depth + 1 });
        if (!visited.has(e.parent_id)) queue.push({ id: e.parent_id, depth: depth + 1 });
      }
    }
    return { nodes, edges };
  }

  /* Collect descendants down to maxDepth. */
  async function descendants(rootId, maxDepth) {
    const nodes = new Map();
    const edges = [];
    const queue = [{ id: rootId, depth: 0 }];
    const visited = new Set();
    while (queue.length) {
      const { id, depth } = queue.shift();
      if (visited.has(id)) continue;
      visited.add(id);
      if (depth >= maxDepth) continue;
      const childEdges = await Data.Relationships.childrenOf(id);
      for (const e of childEdges) {
        edges.push({ parent: e.parent_id, child: e.child_id, subtype: e.subtype });
        const c = await person(e.child_id);
        if (c && !nodes.has(c.id)) nodes.set(c.id, { person: c, depth: depth + 1 });
        if (!visited.has(e.child_id)) queue.push({ id: e.child_id, depth: depth + 1 });
      }
    }
    return { nodes, edges };
  }

  /* Siblings of a person: anyone sharing >=1 parent. half = shares exactly some,
   * full = shares all parents. */
  async function siblings(id) {
    const myParentEdges = await Data.Relationships.parentsOf(id);
    const myParents = new Set(myParentEdges.map((e) => e.parent_id));
    if (myParents.size === 0) return [];
    const sibCount = new Map(); // sibId -> shared parent count
    for (const pid of myParents) {
      const childEdges = await Data.Relationships.childrenOf(pid);
      for (const ce of childEdges) {
        if (ce.child_id === id) continue;
        sibCount.set(ce.child_id, (sibCount.get(ce.child_id) || 0) + 1);
      }
    }
    const out = [];
    for (const [sibId, shared] of sibCount) {
      const p = await person(sibId);
      if (!p) continue;
      out.push({ person: p, half: shared < myParents.size, shared });
    }
    return out;
  }

  /* Spouses & ex-spouses with marriage metadata. */
  async function spouses(id) {
    const marriages = await Data.Marriages.forPerson(id);
    const out = [];
    for (const m of marriages) {
      const otherId = m.spouse1_id === id ? m.spouse2_id : m.spouse1_id;
      const p = await person(otherId);
      if (!p) continue;
      out.push({ person: p, marriage: m, ex: !!m.divorce_date });
    }
    return out;
  }

  /* Full immediate-family snapshot used by editor & focus panel. */
  async function family(id) {
    const me = await person(id);
    const parentEdges = await Data.Relationships.parentsOf(id);
    const childEdges = await Data.Relationships.childrenOf(id);
    const parents = [];
    for (const e of parentEdges) {
      const p = await person(e.parent_id);
      if (p) parents.push({ person: p, subtype: e.subtype });
    }
    const children = [];
    for (const e of childEdges) {
      const c = await person(e.child_id);
      if (c) children.push({ person: c, subtype: e.subtype });
    }
    return {
      me,
      parents,
      children,
      siblings: await siblings(id),
      spouses: await spouses(id)
    };
  }

  /* Assemble the complete hourglass graph for the renderer.
   * `expanded` (optional Set of person ids) is forwarded to the ancestor walk
   * so individually-revealed people each gain one extra generation above them,
   * without deepening the whole tree. */
  async function focusGraph(rootId, upDepth, downDepth, expanded) {
    const root = await person(rootId);
    if (!root) return null;
    const up = await ancestors(rootId, upDepth, expanded);
    const down = await descendants(rootId, downDepth);
    const sps = await spouses(rootId);
    const sibs = await siblings(rootId);

    /* ✅ ADDED (Req 6): co-parent assembly for PARENT-PAIR rendering.
     * The descendant walk only follows parent->child links, so the *other*
     * parent of a child (an in-law spouse) is never collected. Here we look up,
     * for every shown child, its full parent set, and pull in any missing
     * co-parent as a node so married/partnered pairs can be drawn together as a
     * family unit with their children descending from the couple's midpoint.
     * Missing spouses and unknown parents are tolerated (a lone parent simply
     * has no partner beside them). */
    const shown = new Set([rootId, ...down.nodes.keys()]);
    const childParents = {};   // childId -> [parentId, ...]  (every shown child)
    const coParents = new Map(); // personId -> person (in-laws not already shown)
    const coMarriage = {};     // "a|b" sorted pair -> marriage record (if any)

    // lineage parents whose children we are about to inspect: root + every
    // descendant node that itself has children in the graph.
    const lineageParents = new Set([rootId]);
    down.edges.forEach((e) => lineageParents.add(e.parent));

    for (const lp of lineageParents) {
      const childEdges = await Data.Relationships.childrenOf(lp);
      for (const ce of childEdges) {
        if (!shown.has(ce.child_id)) continue; // only children actually rendered
        const pedges = await Data.Relationships.parentsOf(ce.child_id);
        childParents[ce.child_id] = pedges.map((pe) => pe.parent_id);
        for (const pe of pedges) {
          if (pe.parent_id === lp) continue;
          if (!shown.has(pe.parent_id) && !coParents.has(pe.parent_id)) {
            const cp = await person(pe.parent_id);
            if (cp) coParents.set(pe.parent_id, cp);
          }
        }
      }
      // marriage metadata for nicer spouse connectors between co-parents
      const ms = await Data.Marriages.forPerson(lp);
      for (const m of ms) {
        const a = m.spouse1_id, b = m.spouse2_id;
        coMarriage[[a, b].sort().join("|")] = m;
      }
    }

    return {
      root, ancestors: up, descendants: down, spouses: sps, siblings: sibs,
      childParents,
      coParents: Array.from(coParents.values()),
      coMarriage
    };
  }

  FT.Tree = {
    person, hasParents, ancestorFlags,
    ancestors, descendants, siblings, spouses, family, focusGraph
  };
})(window.FT);
