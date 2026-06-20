/* ============================================================================ 
 * models.js — entity factories, normalization, and validation helpers.
 * ========================================================================== */
window.FT = window.FT || {};
(function (FT) {
  "use strict";

  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }

  function nowISO() { return new Date().toISOString(); }

  function lc(v) { return (v == null ? "" : String(v)).trim().toLowerCase(); }

  // ✅ FIXED: now six kinds, matching the editor select and the renderer's
  // "unknown" edge-dash branch (previously only five existed).
  const SUBTYPES = ["biological", "adoptive", "step", "foster", "guardian", "unknown"];
  const EVENT_TYPES = ["birth", "death", "marriage", "divorce", "adoption", "graduation", "immigration", "military_service", "custom"];
  const GENDERS = ["male", "female", "other", "unknown"];

  function person(data, treeId) {
    data = data || {};
    const id = data.id || uid();
    const created = data.created || nowISO();
    const isLiving = data.living === true || data.living === "1" || data.living === 1;
    const p = {
      id,
      tree_id: data.tree_id || treeId || FT.State.activeTreeId,
      first_name: (data.first_name || "").trim(),
      middle_name: (data.middle_name || "").trim(),
      last_name: (data.last_name || "").trim(),
      maiden_name: (data.maiden_name || "").trim(),
      nickname: (data.nickname || "").trim(),
      gender: GENDERS.includes(data.gender) ? data.gender : "unknown",
      birth_date: (data.birth_date || "").trim(),
      death_date: (data.death_date || "").trim(),
      living: isLiving ? 1 : 0,
      birth_place: (data.birth_place || "").trim(),
      death_place: (data.death_place || "").trim(),
      burial_place: (data.burial_place || "").trim(),
      cause_of_death: (data.cause_of_death || "").trim(),
      email: (data.email || "").trim(),
      married_name: (data.married_name || "").trim(),
      upd: (data.upd || "").trim(),
      uid: (data.uid || "").trim(),
      rin: (data.rin || "").trim(),
      residence: (data.residence || "").trim(),
      biography: (data.biography || "").trim(),
      notes: (data.notes || "").trim(),
      occupation: (data.occupation || "").trim(),
      education: (data.education || "").trim(),
      profile_photo_id: data.profile_photo_id || null,
      created,
      updated: nowISO()
    };
    p.first_name_lc = lc(p.first_name);
    p.last_name_lc = lc(p.last_name);
    p.maiden_name_lc = lc(p.maiden_name);
    p.nickname_lc = lc(p.nickname);
    p.occupation_lc = lc(p.occupation);
    p.birth_place_lc = lc(p.birth_place);
    p.burial_place_lc = lc(p.burial_place);
    p.email_lc = lc(p.email);
    return p;
  }

  function relationship(parentId, childId, subtype, treeId) {
    return {
      id: uid(),
      tree_id: treeId || FT.State.activeTreeId,
      type: "parent-child",
      subtype: SUBTYPES.includes(subtype) ? subtype : "biological",
      parent_id: parentId,
      child_id: childId,
      created: nowISO()
    };
  }

  function marriage(data, treeId) {
    data = data || {};
    return {
      id: data.id || uid(),
      tree_id: data.tree_id || treeId || FT.State.activeTreeId,
      spouse1_id: data.spouse1_id,
      spouse2_id: data.spouse2_id,
      marriage_date: (data.marriage_date || "").trim(),
      divorce_date: (data.divorce_date || "").trim(),
      location: (data.location || "").trim(),
      notes: (data.notes || "").trim(),
      created: data.created || nowISO(),
      updated: nowISO()
    };
  }

  function event(data, treeId) {
    data = data || {};
    return {
      id: data.id || uid(),
      tree_id: data.tree_id || treeId || FT.State.activeTreeId,
      type: EVENT_TYPES.includes(data.type) ? data.type : "custom",
      custom_label: (data.custom_label || "").trim(),
      date: (data.date || "").trim(),
      location: (data.location || "").trim(),
      description: (data.description || "").trim(),
      people: Array.isArray(data.people) ? data.people.filter(Boolean) : [],
      created: data.created || nowISO(),
      updated: nowISO()
    };
  }

  function media(data, treeId) {
    data = data || {};
    return {
      id: data.id || uid(),
      tree_id: data.tree_id || treeId || FT.State.activeTreeId,
      person_id: data.person_id || null,
      kind: data.kind || "image",
      name: (data.name || "").trim(),
      mime: data.mime || "application/octet-stream",
      data: data.data || null,
      thumbnail: data.thumbnail || null,
      size: data.size || 0,
      tags: Array.isArray(data.tags) ? data.tags : [],
      description: (data.description || "").trim(),
      created: data.created || nowISO()
    };
  }

  function tree(data) {
    data = data || {};
    return {
      id: data.id || uid(),
      name: (data.name || "Untitled Tree").trim(),
      description: (data.description || "").trim(),
      created: data.created || nowISO(),
      updated: nowISO()
    };
  }

  function fullName(p) {
    if (!p) return "Unknown";
    const parts = [p.first_name, p.middle_name, p.last_name].filter(Boolean);
    let n = parts.join(" ").trim();
    if (!n && p.maiden_name) n = p.maiden_name;
    return n || "Unnamed";
  }

  function displayLines(p) {
    if (!p) return { line1: "Unknown", line2: " " }; // Keep explicit empty space to preserve layout height
    
    const first = (p.first_name || "").trim();
    const last = (p.last_name || "").trim();
    const middle = (p.middle_name || "").trim();
    
    let line1 = [first, last].filter(Boolean).join(" ").trim();
    if (!line1) {
      line1 = (p.maiden_name || p.nickname || "Unnamed").trim();
    }
    // CRITICAL REQUIREMENT: Do not collapse the second line when no middle name exists.
    // Returning a non-empty string with a single whitespace character " " ensures 
    // that the HTML5 Canvas bounding box or textual height metrics do not collapse 
    // the row height, maintaining structural visual uniformity.
    return { 
      line1: line1 || "Unnamed", 
      line2: middle || " " 
    };
  }
  function lifeSpan(p) {
    if (!p) return "";
    const b = (p.birth_date || "").slice(0, 4);
    const d = (p.death_date || "").slice(0, 4);
    if (!b && !d) return p.living ? "" : "deceased";
    if (b && d) return b + "\u2013" + d;
    if (b && p.living) return b + "\u2013";
    if (b) return b + "\u2013?";
    return "?\u2013" + d;
  }

  // Earliest / latest day a partial date (YYYY | YYYY-MM | YYYY-MM-DD) can mean.
  function dateLow(d) {
    if (!d) return null;
    const [y, m, day] = d.split("-");
    return `${y}-${m || "01"}-${day || "01"}`;
  }
  function dateHigh(d) {
    if (!d) return null;
    const [y, m, day] = d.split("-");
    return `${y}-${m || "12"}-${day || "31"}`;
  }

  function validatePerson(p) {
    const errs = [];
    if (!p.first_name && !p.last_name && !p.maiden_name && !p.nickname)
      errs.push("A person needs at least one name field.");
    // ✅ FIXED: compare against the possible RANGE of partial dates so that
    // e.g. birth "1900-05-01" vs death "1900" is no longer a false positive.
    const lo = dateLow(p.birth_date), hi = dateHigh(p.death_date);
    if (lo && hi && lo > hi)
      errs.push("Birth date cannot be after death date.");
    return errs;
  }

  function isValidPartialDate(d) {
    return /^\d{4}(-\d{2}(-\d{2})?)?$/.test(d || "");
  }

  FT.Models = {
    uid, nowISO, lc, person, relationship, marriage, event, media, tree,
    fullName, displayLines, lifeSpan, validatePerson, isValidPartialDate,
    SUBTYPES, EVENT_TYPES, GENDERS
  };
})(window.FT);
