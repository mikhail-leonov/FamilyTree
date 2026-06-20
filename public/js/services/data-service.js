/* ============================================================================
 * services/data-service.js
 * CRUD + integrity for persons, relationships, marriages, events, media.
 * Enforces: no duplicate parent-child edges, no circular ancestry,
 * cascading cleanup of orphaned references, transactional batch ops.
 * ========================================================================== */
window.FT = window.FT || {};

(function (FT) {
  "use strict";
  const DB = FT.DB, M = FT.Models;
  console.log("FT.Data build v14 — import: name + sex + birth-year identity");

  /* ---------------------------------------------------------------- Persons */
  const Persons = {
    async save(data) {
      const p = M.person(data);
      const errs = M.validatePerson(p);
      if (errs.length) throw new Error(errs.join(" "));
      await DB.put("persons", p);
      return p;
    },
    get: (id) => DB.get("persons", id),
    async getMany(ids) {
      const out = [];
      for (const id of ids) {
        const p = await DB.get("persons", id);
        if (p) out.push(p);
      }
      return out;
    },
    countInTree: (treeId) =>
      DB.tx("persons", "readonly", (s) =>
        DB.reqP(s.persons.index("tree_id").count(IDBKeyRange.only(treeId)))
      ),
    /* Delete a person and every reference to them. */
    async remove(id) {
      const stores = ["persons", "relationships", "marriages", "events", "media"];
      await DB.tx(stores, "readwrite", async (s) => {
        await DB.reqP(s.persons.delete(id));
        // parent-child edges where person is parent or child
        for (const ix of ["parent_id", "child_id"]) {
          const edges = await DB.reqP(s.relationships.index(ix).getAll(IDBKeyRange.only(id)));
          for (const e of edges) await DB.reqP(s.relationships.delete(e.id));
        }
        // marriages
        for (const ix of ["spouse1_id", "spouse2_id"]) {
          const ms = await DB.reqP(s.marriages.index(ix).getAll(IDBKeyRange.only(id)));
          for (const m of ms) await DB.reqP(s.marriages.delete(m.id));
        }
        // events: remove the person from people[], drop event if now empty
        const evs = await DB.reqP(s.events.index("people").getAll(IDBKeyRange.only(id)));
        for (const ev of evs) {
          ev.people = ev.people.filter((p) => p !== id);
          if (ev.people.length === 0 && ev.type !== "custom") {
            await DB.reqP(s.events.delete(ev.id));
          } else {
            await DB.reqP(s.events.put(ev));
          }
        }
        // media
        const md = await DB.reqP(s.media.index("person_id").getAll(IDBKeyRange.only(id)));
        for (const m of md) await DB.reqP(s.media.delete(m.id));
      });
    }
  };

  /* -------------------------------------------------------- Relationships */
  /* Returns true if `ancestorId` is an ancestor of `descendantId`
   * (used to block circular parent-child links). */
  async function isAncestor(ancestorId, descendantId) {
    if (ancestorId === descendantId) return true;
    const seen = new Set();
    const queue = [descendantId];
    while (queue.length) {
      const cur = queue.shift();
      if (seen.has(cur)) continue;
      seen.add(cur);
      const edges = await DB.byIndex("relationships", "child_id", IDBKeyRange.only(cur));
      for (const e of edges) {
        if (e.parent_id === ancestorId) return true;
        if (!seen.has(e.parent_id)) queue.push(e.parent_id);
      }
    }
    return false;
  }

  const Relationships = {
    /* Add a parent-child edge with integrity checks. */
    async addParentChild(parentId, childId, subtype) {
      if (!parentId || !childId) throw new Error("Both parent and child are required.");
      if (parentId === childId) throw new Error("A person cannot be their own parent.");
      // duplicate check via composite index
      const existing = await DB.byIndex(
        "relationships", "edge", IDBKeyRange.only([parentId, childId])
      );
      if (existing.length) {
        // update subtype if changed
        const e = existing[0];
        if (subtype && e.subtype !== subtype) {
          e.subtype = subtype;
          await DB.put("relationships", e);
        }
        return e;
      }
      // circular check: child must not already be an ancestor of parent
      if (await isAncestor(childId, parentId)) {
        throw new Error("That link would create a circular ancestry loop.");
      }
      const rel = M.relationship(parentId, childId, subtype);
      await DB.put("relationships", rel);
      return rel;
    },
    async removeEdge(parentId, childId) {
      const existing = await DB.byIndex(
        "relationships", "edge", IDBKeyRange.only([parentId, childId])
      );
      for (const e of existing) await DB.del("relationships", e.id);
    },
    parentsOf: (childId) => DB.byIndex("relationships", "child_id", IDBKeyRange.only(childId)),
    childrenOf: (parentId) => DB.byIndex("relationships", "parent_id", IDBKeyRange.only(parentId)),
    isAncestor
  };

  /* ------------------------------------------------------------ Marriages */
  const Marriages = {
    async save(data) {
      if (!data.spouse1_id || !data.spouse2_id)
        throw new Error("A marriage needs two spouses.");
      if (data.spouse1_id === data.spouse2_id)
        throw new Error("A person cannot marry themselves.");
      if (data.marriage_date && data.divorce_date && data.marriage_date > data.divorce_date)
        throw new Error("Divorce date cannot precede marriage date.");
      // dedupe identical active pair (unless editing existing id)
      if (!data.id) {
        const a = await DB.byIndex("marriages", "spouse1_id", IDBKeyRange.only(data.spouse1_id));
        const b = await DB.byIndex("marriages", "spouse2_id", IDBKeyRange.only(data.spouse1_id));
        const dup = a.concat(b).find(
          (m) => (m.spouse2_id === data.spouse2_id || m.spouse1_id === data.spouse2_id)
        );
        if (dup) throw new Error("A marriage record already exists for this couple.");
      }
      const m = M.marriage(data);
      await DB.put("marriages", m);
      return m;
    },
    get: (id) => DB.get("marriages", id),
    remove: (id) => DB.del("marriages", id),
    async forPerson(personId) {
      const a = await DB.byIndex("marriages", "spouse1_id", IDBKeyRange.only(personId));
      const b = await DB.byIndex("marriages", "spouse2_id", IDBKeyRange.only(personId));
      const seen = new Set();
      return a.concat(b).filter((m) => (seen.has(m.id) ? false : seen.add(m.id)));
    }
  };

  /* --------------------------------------------------------------- Events */
  const Events = {
    async save(data) {
      const e = M.event(data);
      await DB.put("events", e);
      return e;
    },
    get: (id) => DB.get("events", id),
    remove: (id) => DB.del("events", id),
    forPerson: (personId) => DB.byIndex("events", "people", IDBKeyRange.only(personId)),
    byType: (type) => DB.byIndex("events", "type", IDBKeyRange.only(type))
  };

  /* --------------------------------------------------------------- Media */
  const Media = {
    async save(data) {
      const m = M.media(data);
      await DB.put("media", m);
      return m;
    },
    get: (id) => DB.get("media", id),
    remove: (id) => DB.del("media", id),
    forPerson: (personId) => DB.byIndex("media", "person_id", IDBKeyRange.only(personId))
  };

/* ------------------------------------------------------- Batch / bulk ops */
  const Batch = {
    /* Insert many heterogeneous records in a single transaction (NO dedup).
     * payload: { persons:[], relationships:[], marriages:[], events:[], media:[] } */
    async insert(payload) {
      const stores = ["persons", "relationships", "marriages", "events", "media"];
      await DB.tx(stores, "readwrite", async (s) => {
        for (const name of stores) {
          const items = payload[name] || [];
          for (const it of items) await DB.reqP(s[name].put(it));
        }
      });
    },

    /* ✅ De-duplicating, conflict-aware import. Source-agnostic (GEDCOM or JSON).
     *
     * A person who already exists in the tree is matched by NAME identity
     * (first middle last|maiden, case-insensitive); unnamed people never
     * auto-merge. When a match is found the existing record is UPDATED in place;
     * otherwise a brand-new person is created. References are remapped, and
     * duplicate parent-child edges, marriages and events are skipped.
     *
     * For a matched person each attribute is reconciled one by one:
     *   - both blank ............ nothing to do
     *   - existing blank ........ fill from the incoming value
     *   - incoming blank ........ keep the existing value
     *   - both set & equal ...... skip (already agree)
     *   - both set & different .. DO NOT overwrite — record it in the conflict log
     *
     * Returns { treeId, stats, conflicts } where `conflicts` is a list of
     * { person_id, person_name, field, existing, incoming } the caller can show
     * or download. `stats.conflicts` mirrors `conflicts.length`. */
    async merge(payload, treeId) {
      treeId = treeId || FT.State.activeTreeId;
      payload = payload || {};
      const inPersons = payload.persons || [];
      const inRels    = payload.relationships || [];
      const inMarr    = payload.marriages || [];
      const inEvents  = payload.events || [];
      const inMedia   = payload.media || [];

      // ---- identity keys ------------------------------------------------
      // Persons match on NAME, then a same-name candidate is only treated as the
      // SAME person when sex and birth year also agree (see samePerson below).
      // Any non-empty name is eligible so that re-imports de-duplicate cleanly;
      // the real safety comes from the sex/birth-year gate, not from the key.
      const personKey = (p) => {
        const name = [M.lc(p.first_name), M.lc(p.middle_name),
                      M.lc(p.last_name) || M.lc(p.maiden_name)]
                     .join(" ").replace(/\s+/g, " ").trim();
        return name || null;                            // unnamed: never auto-merge
      };
      // Two same-name records are the SAME person only when their known sex
      // agrees AND their known birth YEAR agrees. A different birth year (e.g. a
      // father "Ivan Negovora" born 1911 and his son "Ivan Negovora" born 1940)
      // means different people even though the names match.
      const birthYear = (d) => { const m = String(d || "").match(/\d{4}/); return m ? m[0] : ""; };
      const knownSex  = (g) => (g && g !== "unknown") ? g : "";
      const samePerson = (a, b) => {
        const sA = knownSex(a.gender), sB = knownSex(b.gender);
        if (sA && sB && sA !== sB) return false;        // known, conflicting sex
        const yA = birthYear(a.birth_date), yB = birthYear(b.birth_date);
        if (yA && yB && yA !== yB) return false;        // known, conflicting birth year
        return true;
      };
      const relKey   = (r) => r.parent_id + ">" + r.child_id;
      const marrKey  = (m) => [m.spouse1_id, m.spouse2_id].slice().sort().join("&");
      const evKey    = (e) => [e.type, e.date || "",
                               (e.people || []).slice().sort().join(","),
                               e.type === "custom" ? (e.custom_label || e.description || "") : ""].join("|");
      const mediaKey = (m) => (m.person_id || "") + "|" + (m.name || "") + "|" + (m.size || 0);

      // Substantive fields reconciled with the fill / skip / conflict rules.
      const MERGE_FIELDS = ["first_name", "middle_name", "last_name", "maiden_name", "nickname",
                            "birth_date", "death_date", "birth_place", "death_place", "residence",
                            "biography", "notes", "occupation", "education",
                            "burial_place", "cause_of_death", "email", "married_name", "upd", "uid", "rin"
                           ];
      // Fill-only fields: back-fill when blank but never raise a conflict.
      const FILL_ONLY = ["profile_photo_id"];

      const stats = { persons: 0, merged: 0, relationships: 0, marriages: 0, events: 0, media: 0, conflicts: 0 };
      const conflicts = [];
      const blank = (v) => v == null || String(v).trim() === "";

      // Reconcile one incoming person `p` onto an existing record `ex`.
      // Mutates `ex`, returns true when `ex` was changed.
      function reconcile(ex, p) {
        let changed = false;
        for (const f of MERGE_FIELDS) {
          const a = blank(ex[f]) ? "" : String(ex[f]).trim();
          const b = blank(p[f])  ? "" : String(p[f]).trim();
          if (!a && !b) continue;                       // both blank
          if (!a && b) { ex[f] = p[f]; changed = true; continue; } // fill blank
          if (a && !b) continue;                        // keep existing
          if (M.lc(a) === M.lc(b)) continue;            // equal -> skip
          // Date refinement: when one date is a more specific form of the other
          // (e.g. "1911" vs "1911-05-02"), keep the more specific one instead of
          // flagging a conflict. (Different years never reach here — such records
          // are treated as different people and never merged.)
          if (f === "birth_date" || f === "death_date") {
            if (b.startsWith(a) || a.startsWith(b)) {
              const better = b.length > a.length ? p[f] : ex[f];
              if (ex[f] !== better) { ex[f] = better; changed = true; }
              continue;
            }
          }
          // both present and different -> leave existing, log the conflict
          conflicts.push({ person_id: ex.id, person_name: M.fullName(ex), field: f, existing: a, incoming: b });
        }
        // gender: treat "unknown" as blank
        const ga = (ex.gender && ex.gender !== "unknown") ? ex.gender : "";
        const gb = (p.gender && p.gender !== "unknown") ? p.gender : "";
        if (!ga && gb) { ex.gender = gb; changed = true; }
        else if (ga && gb && ga !== gb)
          conflicts.push({ person_id: ex.id, person_name: M.fullName(ex), field: "gender", existing: ga, incoming: gb });
        // fill-only fields
        for (const f of FILL_ONLY) {
          if (blank(ex[f]) && !blank(p[f])) { ex[f] = p[f]; changed = true; }
        }
        return changed;
      }

      const stores = ["persons", "relationships", "marriages", "events", "media"];

      await DB.tx(stores, "readwrite", async (s) => {
        // ---- existing records in this tree ------------------------------
        const exPersons = await DB.reqP(s.persons.index("tree_id").getAll(IDBKeyRange.only(treeId)));
        const keyToIds   = new Map();   // name key -> [candidate person ids] (one name can host several distinct people)
        const personById = new Map();   // id -> person object (for back-fill)
        const addCandidate = (k, id) => {
          if (!k) return;
          const a = keyToIds.get(k);
          if (a) a.push(id); else keyToIds.set(k, [id]);
        };
        for (const p of exPersons) {
          personById.set(p.id, p);
          addCandidate(personKey(p), p.id);
        }
        const relSeen   = new Set((await DB.reqP(s.relationships.index("tree_id").getAll(IDBKeyRange.only(treeId)))).map(relKey));
        const marrSeen  = new Set((await DB.reqP(s.marriages.index("tree_id").getAll(IDBKeyRange.only(treeId)))).map(marrKey));
        const evSeen    = new Set((await DB.reqP(s.events.index("tree_id").getAll(IDBKeyRange.only(treeId)))).map(evKey));
        const mediaSeen = new Set((await DB.reqP(s.media.index("tree_id").getAll(IDBKeyRange.only(treeId)))).map(mediaKey));

        // ---- persons: build id remap, insert only genuinely new ones ----
        const idMap = new Map();        // incoming id -> canonical id
        for (const raw of inPersons) {
          const incomingId = raw && raw.id != null ? raw.id : null;
          const p = M.person(Object.assign({}, raw, { tree_id: treeId }), treeId);
          const k = personKey(p);

          // Among existing records that share this name, find the one that is
          // actually the same person (sex- and birth-year-compatible).
          let canon = null;
          if (k && keyToIds.has(k)) {
            for (const id of keyToIds.get(k)) {
              const ex = personById.get(id);
              if (ex && samePerson(ex, p)) { canon = id; break; }
            }
          }

          if (canon != null) {
            // Match found -> UPDATE the existing record attribute by attribute.
            idMap.set(incomingId != null ? incomingId : p.id, canon);
            stats.merged++;
            const ex = personById.get(canon);
            if (ex) {
              const changed = reconcile(ex, p);
              if (changed) {
                const filled = M.person(ex, treeId);
                await DB.reqP(s.persons.put(filled));
                personById.set(canon, filled);
              }
            }
            continue;
          }

          // New person (no existing match, or a name-twin who is a different
          // person). NOTE: we deliberately do NOT add this person to the
          // candidate pool — every record in a single import is a distinct
          // individual, so they must never merge into each other. De-duplication
          // only ever matches an incoming person against people ALREADY in the
          // tree (pre-seeded above), which is what makes re-imports idempotent.
          await DB.reqP(s.persons.put(p));
          idMap.set(incomingId != null ? incomingId : p.id, p.id);
          personById.set(p.id, p);
          stats.persons++;
        }

        const remap = (id) => (id != null && idMap.has(id)) ? idMap.get(id) : id;

        // ---- relationships: remap + skip duplicate edges ----------------
        for (const raw of inRels) {
          const parent = remap(raw.parent_id);
          const child  = remap(raw.child_id);
          if (!parent || !child || parent === child) continue;
          const k = parent + ">" + child;
          if (relSeen.has(k)) continue;
          relSeen.add(k);
          await DB.reqP(s.relationships.put(M.relationship(parent, child, raw.subtype, treeId)));
          stats.relationships++;
        }

        // ---- marriages: remap + skip duplicate couples ------------------
        for (const raw of inMarr) {
          const data = Object.assign({}, raw, {
            tree_id: treeId,
            spouse1_id: remap(raw.spouse1_id),
            spouse2_id: remap(raw.spouse2_id)
          });
          if (!data.spouse1_id || !data.spouse2_id || data.spouse1_id === data.spouse2_id) continue;
          const m = M.marriage(data, treeId);
          const k = marrKey(m);
          if (marrSeen.has(k)) continue;
          marrSeen.add(k);
          await DB.reqP(s.marriages.put(m));
          stats.marriages++;
        }

        // ---- events: remap people + skip duplicate events ---------------
        for (const raw of inEvents) {
          const people = (raw.people || []).map(remap).filter(Boolean);
          const e = M.event(Object.assign({}, raw, { tree_id: treeId, people }), treeId);
          const k = evKey(e);
          if (evSeen.has(k)) continue;
          evSeen.add(k);
          await DB.reqP(s.events.put(e));
          stats.events++;
        }

        // ---- media: remap owner + skip duplicates -----------------------
        for (const raw of inMedia) {
          const m = M.media(Object.assign({}, raw, { tree_id: treeId, person_id: remap(raw.person_id) }), treeId);
          const k = mediaKey(m);
          if (mediaSeen.has(k)) continue;
          mediaSeen.add(k);
          await DB.reqP(s.media.put(m));
          stats.media++;
        }
      });

      stats.conflicts = conflicts.length;
      return { treeId, stats, conflicts };
    }
  };

  FT.Data = { Persons, Relationships, Marriages, Events, Media, Batch, isAncestor };
})(window.FT);