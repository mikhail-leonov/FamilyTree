/* ============================================================================
 * gedcom-parser.js
 * Parses GEDCOM 5.5 / 5.5.1 / 7.0 into the internal IndexedDB schema.
 * Unsupported tags are ignored gracefully. Relationships from FAM records are
 * normalized into parent-child edges + marriage records.
 * ========================================================================== */
window.FT = window.FT || {};

(function (FT) {
  "use strict";
  const M = FT.Models;

  const MAX_LIFESPAN = 110; // years; older-than-this with no death tag => deceased

  /* Parse raw GEDCOM text into a flat list of nodes, then nest by level. */
  function tokenize(text) {
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    const root = { level: -1, children: [] };
    const stack = [root];
    for (const raw of lines) {
      if (!raw.trim()) continue;
      const m = raw.match(/^\s*(\d+)\s+(@[^@]+@\s+)?(\S+)(?:\s(.*))?$/);
      if (!m) continue;
      const level = parseInt(m[1], 10);
      const xref = m[2] ? m[2].trim() : null;
      const tag = m[3];
      const value = m[4] != null ? m[4] : "";
      const node = { level, xref, tag, value, children: [] };
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      (stack[stack.length - 1] || root).children.push(node);
      stack.push(node);
    }
    return root.children;
  }

  function child(node, tag) {
    if (!node) return null;
    return node.children.find((c) => c.tag === tag) || null;
  }
  function childValue(node, tag) {
    if (!node) return "";
    const c = child(node, tag);
    return c ? joinCont(c) : "";
  }
  /* Reassemble CONT/CONC continuation lines. */
  function joinCont(node) {
    let v = node.value || "";
    for (const c of node.children) {
      if (c.tag === "CONC") v += c.value;
      else if (c.tag === "CONT") v += "\n" + c.value;
    }
    return v;
  }

  /* GEDCOM date -> best-effort ISO (yyyy or yyyy-mm or yyyy-mm-dd). */
  function gedDate(value) {
    if (!value) return "";
    const months = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };
    const cleaned = value.replace(/^(ABT|EST|CAL|BEF|AFT|FROM|TO|BET|AND)\s+/gi, "").trim();
    const m = cleaned.match(/(?:(\d{1,2})\s+)?(?:([A-Z]{3})\s+)?(\d{3,4})/i);
    if (!m) return "";
    const day = m[1] ? m[1].padStart(2, "0") : null;
    const mon = m[2] ? months[m[2].toUpperCase()] : null;
    const year = m[3];
    if (day && mon) return `${year}-${mon}-${day}`;
    if (mon) return `${year}-${mon}`;
    return year;
  }

  function getPlace(node) {
    if (!node) return "";
    if (node.value && node.value.trim()) return node.value.trim();
    const loc = node.children.find(c => c.tag === "_LOC" || c.tag === "GEO" || c.tag === "MAP");
    if (loc && loc.value) return loc.value.trim();
    return node.children.map(c => c.value).join(" ").trim();
  }

  function eventInfo(node, tag) {
    if (!node) return { date: "", place: "" };
    const c = child(node, tag);
    if (!c) return { date: "", place: "" };
    return { date: gedDate(childValue(c, "DATE")), place: getPlace(child(c, "PLAC")) };
  }

  /* Map a NAME value "Given /Surname/" -> {first, last}. */
  function parseName(value) {
    const m = value.match(/^(.*?)\/(.*?)\/(.*)$/);
    if (m) {
      const given = m[1].trim();
      const surname = m[2].trim();
      const parts = given.split(/\s+/).filter(Boolean);
      return {
        first: parts[0] || "",
        middle: parts.slice(1).join(" "),
        last: surname
      };
    }
    const parts = value.trim().split(/\s+/);
    return { first: parts[0] || "", middle: parts.slice(1, -1).join(" "), last: parts.length > 1 ? parts[parts.length - 1] : "" };
  }

  // ✅ FIXED: a record with no DEAT tag is no longer blindly "living". If the
  // birth year is more than a plausible lifetime ago, treat them as deceased.
  function inferLiving(hasDeathTag, birthDate) {
    if (hasDeathTag) return false;
    const by = parseInt((birthDate || "").slice(0, 4), 10);
    if (by) {
      const age = new Date().getFullYear() - by;
      if (age > MAX_LIFESPAN) return false;
    }
    return true;
  }

  /* Main entry: returns { payload, stats } ready for FT.Data.Batch.insert. */
  function parse(text, treeId) {
    const nodes = tokenize(text);
    const xrefToPerson = {};
    const persons = [];
    const relationships = [];
    const marriages = [];
    const events = [];

    const indiNodes = nodes.filter((n) => n.tag === "INDI");
    const famNodes = nodes.filter((n) => n.tag === "FAM");

    // First pass: individuals
    for (const n of indiNodes) {
      const nameNode = child(n, "NAME");
      const nm = nameNode ? parseName(nameNode.value) : { first: "", middle: "", last: "" };
      const sexRaw = childValue(n, "SEX").toUpperCase();
      const gender = sexRaw === "M" ? "male" : sexRaw === "F" ? "female" : "unknown";
      const birth = eventInfo(n, "BIRT");
      const death = eventInfo(n, "DEAT");
      const occu = childValue(n, "OCCU");
      const note = childValue(n, "NOTE");
      const deathChild = child(n, "DEAT");
      const burial = childValue(child(n, "BURI"), "PLAC");
      const cause = childValue(child(n, "DEAT"), "CAUS");
      const email = (() => {
         const resi = child(n, "RESI");
         return resi ? childValue(resi, "EMAIL") : "";
      })();
      const marriedName = childValue(n, "_MARNM");
      const upd = childValue(n, "_UPD");
      const uid = childValue(n, "_UID");
      const rin = childValue(n, "RIN");
      // also capture the main RESI text (if any) – but GEDCOM uses EMAIL child
      const residence = childValue(n, "RESI") || ""; // fallback


      const p = M.person({
        first_name: nm.first,
        middle_name: nm.middle,
        last_name: nm.last,
        gender,
        birth_date: birth.date,
        birth_place: birth.place,
        death_date: death.date,
        death_place: death.place,
        living: inferLiving(!!deathChild, birth.date),
        occupation: occu,
        notes: note,
        burial_place: burial,
        cause_of_death: cause,
        email: email,
        married_name: marriedName,
        upd: upd,
        uid: uid,
        rin: rin,
        residence: residence,
      }, treeId);
      xrefToPerson[n.xref] = p.id;
      persons.push(p);
    }

    // Second pass: families => parent-child edges + marriages + marriage events
    for (const f of famNodes) {
      const husb = childValue(f, "HUSB");
      const wife = childValue(f, "WIFE");
      const husbId = xrefToPerson[husb];
      const wifeId = xrefToPerson[wife];
      const childNodes = f.children.filter((c) => c.tag === "CHIL");

      // marriage
      const marr = child(f, "MARR");
      const div = child(f, "DIV");
      if (husbId && wifeId) {
        const marriageDate = marr ? gedDate(childValue(marr, "DATE")) : "";
        const marriageLoc = marr ? childValue(marr, "PLAC") : "";
        const divorceDate = div ? gedDate(childValue(div, "DATE")) : "";
        const m = M.marriage({
          spouse1_id: husbId, spouse2_id: wifeId,
          marriage_date: marriageDate, divorce_date: divorceDate, location: marriageLoc
        }, treeId);
        marriages.push(m);
        if (marriageDate) {
          events.push(M.event({ type: "marriage", date: marriageDate, location: marriageLoc, people: [husbId, wifeId] }, treeId));
        }
        if (divorceDate) {
          events.push(M.event({ type: "divorce", date: divorceDate, people: [husbId, wifeId] }, treeId));
        }
      }

      // parent-child edges
      for (const cn of childNodes) {
        const childId = xrefToPerson[cn.value];
        if (!childId) continue;
        if (husbId) relationships.push(M.relationship(husbId, childId, "biological", treeId));
        if (wifeId) relationships.push(M.relationship(wifeId, childId, "biological", treeId));
      }
    }

    return {
      payload: { persons, relationships, marriages, events, media: [] },
      stats: {
        persons: persons.length,
        families: famNodes.length,
        relationships: relationships.length,
        marriages: marriages.length,
        events: events.length
      }
    };
  }

  FT.GedcomParser = { parse, tokenize, gedDate, parseName };
})(window.FT);
