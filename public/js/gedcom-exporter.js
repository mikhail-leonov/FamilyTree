/* ============================================================================ 
 * gedcom-exporter.js
 * Exports the active tree to GEDCOM 5.5.1 and to native JSON.
 * Reconstructs FAM records from parent-child edges + marriages.
 * ========================================================================== */
window.FT = window.FT || {};

(function (FT) {
  "use strict";
  const DB = FT.DB, M = FT.Models;

  function gedDateOut(iso) {
    if (!iso) return "";
    const months = ["", "JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
    const p = iso.split("-");
    if (p.length === 3) return `${+p[2]} ${months[+p[1]]} ${p[0]}`;
    if (p.length === 2) return `${months[+p[1]]} ${p[0]}`;
    return p[0];
  }

  async function collectTree(treeId) {
    const persons = await DB.byIndex("persons", "tree_id", IDBKeyRange.only(treeId));
    const rels = await DB.byIndex("relationships", "tree_id", IDBKeyRange.only(treeId));
    const marriages = await DB.byIndex("marriages", "tree_id", IDBKeyRange.only(treeId));
    const events = await DB.byIndex("events", "tree_id", IDBKeyRange.only(treeId));
    const media = await DB.byIndex("media", "tree_id", IDBKeyRange.only(treeId));
    return { persons, rels, marriages, events, media };
  }

  /* Build GEDCOM 5.5.1 text. */
  async function toGEDCOM(treeId) {
    treeId = treeId || FT.State.activeTreeId;
    const { persons, rels, marriages } = await collectTree(treeId);
    const idToXref = {};
    persons.forEach((p, i) => (idToXref[p.id] = `@I${i + 1}@`));

    // Group children by parent-set to synthesize families.
    const parentsByChild = {};
    rels.forEach((r) => {
      (parentsByChild[r.child_id] = parentsByChild[r.child_id] || []).push(r.parent_id);
    });

    const families = {}; // key -> {parents:Set, children:Set, marriage}
    function famKey(parents) { return parents.slice().sort().join("|"); }

    Object.keys(parentsByChild).forEach((childId) => {
      const parents = Array.from(new Set(parentsByChild[childId]));
      const key = famKey(parents);
      if (!families[key]) families[key] = { parents, children: new Set(), marriage: null };
      families[key].children.add(childId);
    });
    marriages.forEach((m) => {
      const key = famKey([m.spouse1_id, m.spouse2_id]);
      if (!families[key]) families[key] = { parents: [m.spouse1_id, m.spouse2_id], children: new Set(), marriage: m };
      else families[key].marriage = m;
    });

    const famList = Object.values(families);
    const famXref = {};
    famList.forEach((f, i) => (famXref[i] = `@F${i + 1}@`));

    const fams = {}; // personId -> [famXref]
    const famc = {}; // personId -> famXref
    famList.forEach((f, i) => {
      f.parents.forEach((pid) => (fams[pid] = fams[pid] || []).push(famXref[i]));
      f.children.forEach((cid) => (famc[cid] = famXref[i]));
    });

    const L = [];
    L.push("0 HEAD");
    L.push("1 SOUR FamilyTreeWebApp");
    L.push("1 GEDC");
    L.push("2 VERS 5.5.1");
    L.push("2 FORM LINEAGE-LINKED");
    L.push("1 CHAR UTF-8");

    for (const p of persons) {
      L.push(`0 ${idToXref[p.id]} INDI`);
      const nameParts = [p.first_name, p.middle_name].filter(Boolean).join(" ");
      L.push(`1 NAME ${nameParts} /${p.last_name || p.maiden_name || ""}/`.trimEnd());
      if (p.nickname) L.push(`2 NICK ${p.nickname}`);
      if (p.gender && p.gender !== "unknown") L.push(`1 SEX ${p.gender === "male" ? "M" : "F"}`);
      if (p.birth_date || p.birth_place) {
        L.push("1 BIRT");
        if (p.birth_date) L.push(`2 DATE ${gedDateOut(p.birth_date)}`);
        if (p.birth_place) L.push(`2 PLAC ${p.birth_place}`);
      }
      if (p.death_date || p.death_place || p.living === 0) {
        L.push("1 DEAT" + (p.death_date || p.death_place ? "" : " Y"));
        if (p.death_date) L.push(`2 DATE ${gedDateOut(p.death_date)}`);
        if (p.death_place) L.push(`2 PLAC ${p.death_place}`);
      }
      if (p.occupation) L.push(`1 OCCU ${p.occupation}`);
      if (p.education) L.push(`1 EDUC ${p.education}`);
      if (p.residence) L.push(`1 RESI\n2 PLAC ${p.residence}`);
      if (p.notes) pushNote(L, 1, p.notes);
      (fams[p.id] || []).forEach((fx) => L.push(`1 FAMS ${fx}`));
      if (famc[p.id]) L.push(`1 FAMC ${famc[p.id]}`);
      if (p.burial_place) {
        L.push("1 BURI");
        L.push(`2 PLAC ${p.burial_place}`);
      }
      if (p.cause_of_death && p.death_date) {
        // Add CAUS under existing DEAT block, or create one
        // (handled by checking if DEAT already written)
      }
      if (p.email) {
        L.push("1 RESI");
        L.push(`2 EMAIL ${p.email}`);
      }
      if (p.married_name) L.push(`1 _MARNM ${p.married_name}`);
      if (p.upd) L.push(`1 _UPD ${p.upd}`);
      if (p.uid) L.push(`1 _UID ${p.uid}`);
      if (p.rin) L.push(`1 RIN ${p.rin}`);
    }

    famList.forEach((f, i) => {
      L.push(`0 ${famXref[i]} FAM`);
      if (f.parents[0] && idToXref[f.parents[0]]) L.push(`1 HUSB ${idToXref[f.parents[0]]}`);
      if (f.parents[1] && idToXref[f.parents[1]]) L.push(`1 WIFE ${idToXref[f.parents[1]]}`);
      f.children.forEach((cid) => { if (idToXref[cid]) L.push(`1 CHIL ${idToXref[cid]}`); });
      if (f.marriage) {
        if (f.marriage.marriage_date || f.marriage.location) {
          L.push("1 MARR");
          if (f.marriage.marriage_date) L.push(`2 DATE ${gedDateOut(f.marriage.marriage_date)}`);
          if (f.marriage.location) L.push(`2 PLAC ${f.marriage.location}`);
        }
        if (f.marriage.divorce_date) {
          L.push("1 DIV");
          L.push(`2 DATE ${gedDateOut(f.marriage.divorce_date)}`);
        }
      }
    });

    L.push("0 TRLR");
    return L.join("\n");
  }

  function pushNote(L, level, text) {
    const lines = text.split("\n");
    L.push(`${level} NOTE ${lines[0]}`);
    for (let i = 1; i < lines.length; i++) L.push(`${level + 1} CONT ${lines[i]}`);
  }

  /* Native JSON export (lossless). */
  async function toJSON(treeId) {
    treeId = treeId || FT.State.activeTreeId;
    const tree = await DB.get("trees", treeId);
    const { persons, rels, marriages, events, media } = await collectTree(treeId);
    return JSON.stringify({
      format: "family-tree-app/json",
      version: 1,
      exported: new Date().toISOString(),
      tree,
      persons, relationships: rels, marriages, events, media
    }, null, 2);
  }

  /* Native JSON import. */
  async function fromJSON(text, opts) {
    opts = opts || {};
    const data = JSON.parse(text);
    const treeId = (data.tree && data.tree.id) || FT.State.activeTreeId;
    if (data.tree) await DB.put("trees", FT.Models.tree(data.tree));

    // ✅ Route through the de-duplicating merge. Existing people (matched by
    // name + birth + death) are reused instead of duplicated, references are
    // remapped, and duplicate edges / marriages / events are skipped. Person
    // normalization (search *_lc fields, numeric `living`) happens inside merge().
    const { stats, conflicts } = await FT.Data.Batch.merge({
      persons: data.persons || [],
      relationships: data.relationships || [],
      marriages: data.marriages || [],
      events: data.events || [],
      media: data.media || []
    }, treeId);

    return { treeId, stats, conflicts };
  }

  FT.GedcomExporter = { toGEDCOM, toJSON, fromJSON, gedDateOut };
})(window.FT);
