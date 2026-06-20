/* ============================================================================
 * services/search-service.js 
 * Global search using IndexedDB indexes for prefix matching across name,
 * maiden name, nickname, occupation, and birthplace. Free-text fields
 * (notes/biography) fall back to a bounded cursor scan.
 * ========================================================================== */
window.FT = window.FT || {};

(function (FT) {
  "use strict";
  const DB = FT.DB, M = FT.Models;

  /* Build a prefix key range: ["abc", "abc\uffff"] for case-insensitive prefix. */
  function prefixRange(term) {
    const lc = M.lc(term);
    return IDBKeyRange.bound(lc, lc + "\uffff");
  }

  const INDEXED_FIELDS = [
    { index: "last_name", label: "Last name" },
    { index: "first_name", label: "First name" },
    { index: "maiden_name", label: "Maiden name" },
    { index: "nickname", label: "Nickname" },
    { index: "occupation", label: "Occupation" },
    { index: "birth_place", label: "Birthplace" },
    { index: "email_lc", label: "Email" },
    { index: "burial_place_lc", label: "Burial place" }
  ];

  /* Indexed prefix search. Returns unique persons (optionally tree-scoped),
   * each tagged with which field matched. */
  async function search(term, opts) {
    opts = opts || {};
    const treeId = opts.treeId || FT.State.activeTreeId;
    const limit = opts.limit || 100;
    if (!term || !term.trim()) return [];
    const range = prefixRange(term);
    const found = new Map(); // id -> {person, fields:Set}

    for (const f of INDEXED_FIELDS) {
      const rows = await DB.byIndex("persons", f.index, range, limit * 2);
      for (const p of rows) {
        if (treeId && p.tree_id !== treeId) continue;
        if (!found.has(p.id)) found.set(p.id, { person: p, fields: new Set() });
        found.get(p.id).fields.add(f.label);
        if (found.size >= limit) break;
      }
    }

    // Optional free-text scan over notes/biography (slower, bounded).
    if (opts.includeNotes) {
      const needle = M.lc(term);
      await DB.cursor("persons", "tree_id",
        treeId ? IDBKeyRange.only(treeId) : null, "next", (p) => {
          if (found.size >= limit) return false;
          if (
            M.lc(p.notes).includes(needle) ||
            M.lc(p.biography).includes(needle)
          ) {
            if (!found.has(p.id)) found.set(p.id, { person: p, fields: new Set() });
            found.get(p.id).fields.add("Notes");
          }
          return true;
        });
    }

    return Array.from(found.values())
      .map((v) => ({ ...v.person, _matched: Array.from(v.fields) }))
      .sort((a, b) =>
        (a.last_name_lc + a.first_name_lc).localeCompare(b.last_name_lc + b.first_name_lc)
      )
      .slice(0, limit);
  }

  FT.Search = { search, prefixRange };
})(window.FT);
