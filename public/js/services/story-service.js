/* ============================================================================
 * services/story-service.js 
 * Generates readable narratives from stored data: a prose biography, a
 * chronological timeline, and a printable summary.
 * ========================================================================== */
window.FT = window.FT || {};

(function (FT) {
  "use strict";
  const M = FT.Models, Tree = FT.Tree, Data = FT.Data;

  function yearOf(d) { return d ? d.slice(0, 4) : ""; }
  function nice(d) {
    if (!d) return "an unknown date";
    const parts = d.split("-");
    const months = ["", "January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December"];
    if (parts.length === 3) return `${months[+parts[1]] || parts[1]} ${+parts[2]}, ${parts[0]}`;
    if (parts.length === 2) return `${months[+parts[1]] || parts[1]} ${parts[0]}`;
    return parts[0];
  }
  function pronoun(g, type) {
    const map = {
      male: { subj: "he", poss: "his", obj: "him" },
      female: { subj: "she", poss: "her", obj: "her" }
    };
    return (map[g] || { subj: "they", poss: "their", obj: "them" })[type];
  }
  function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

  /* Prose biography. */
  async function narrative(personId) {
    const fam = await Tree.family(personId);
    const p = fam.me;
    if (!p) return "";
    const name = M.fullName(p);
    const subj = pronoun(p.gender, "subj");
    const poss = pronoun(p.gender, "poss");
    const lines = [];

    // Opening: birth
    let open = `${name} `;
    if (p.birth_date && p.birth_place) open += `was born on ${nice(p.birth_date)} in ${p.birth_place}.`;
    else if (p.birth_date) open += `was born on ${nice(p.birth_date)}.`;
    else if (p.birth_place) open += `was born in ${p.birth_place}.`;
    else open += `appears in the family records, though ${poss} birth details are unknown.`;
    lines.push(open);

    // Parents
    if (fam.parents.length) {
      const names = fam.parents.map((x) => {
        const yr = yearOf(x.person.birth_date);
        return M.fullName(x.person) + (yr ? ` (born ${yr})` : "");
      });
      const adopt = fam.parents.some((x) => x.subtype === "adoptive");
      lines.push(
        `${cap(subj)} ${adopt ? "was raised by" : "was the child of"} ${listify(names)}.`
      );

      // Parents' marriage / divorce to each other
      if (fam.parents.length >= 2) {
        const pa = fam.parents[0].person, pb = fam.parents[1].person;
        const pms = await Data.Marriages.forPerson(pa.id);
        const pm = pms.find((m) => m.spouse1_id === pb.id || m.spouse2_id === pb.id);
        if (pm && (pm.marriage_date || pm.divorce_date)) {
          if (pm.marriage_date) {
            let s = `${M.fullName(pa)} and ${M.fullName(pb)} married`;
            s += ` on ${nice(pm.marriage_date)}`;
            if (pm.location) s += ` in ${pm.location}`;
            s += ".";
            lines.push(s);
          }
          if (pm.divorce_date) lines.push(`They divorced in ${yearOf(pm.divorce_date)}.`);
        }
      }
    }

    // Siblings
    if (fam.siblings.length) {
      const full = fam.siblings.filter((s) => !s.half).map((s) => M.fullName(s.person));
      const half = fam.siblings.filter((s) => s.half).map((s) => M.fullName(s.person));
      if (full.length) lines.push(`${cap(poss)} sibling${full.length > 1 ? "s were" : " was"} ${listify(full)}.`);
      if (half.length) lines.push(`${cap(subj)} also had ${half.length > 1 ? "half-siblings" : "a half-sibling"}: ${listify(half)}.`);
    }

    // Education / occupation
    if (p.education) lines.push(`${cap(subj)} studied ${p.education}.`);
    if (p.occupation) lines.push(`${cap(subj)} worked as ${aOrAn(p.occupation)}.`);

    // Marriages
    for (const sp of fam.spouses) {
      const sn = M.fullName(sp.person);
      let s = `${cap(subj)} married ${sn}`;
      if (sp.marriage.marriage_date) s += ` on ${nice(sp.marriage.marriage_date)}`;
      if (sp.marriage.location) s += ` in ${sp.marriage.location}`;
      s += ".";
      if (sp.marriage.divorce_date) s += ` The marriage ended in ${yearOf(sp.marriage.divorce_date)}.`;
      lines.push(s);
    }

    // Children
    if (fam.children.length) {
      const cn = fam.children.map((c) => {
        const yr = yearOf(c.person.birth_date);
        return M.fullName(c.person) + (yr ? ` (born ${yr})` : "");
      });
      lines.push(`${cap(subj)} had ${fam.children.length} ${fam.children.length > 1 ? "children" : "child"}: ${listify(cn)}.`);
    }

    // Residence
    if (p.residence) lines.push(`In later records ${subj} resided in ${p.residence}.`);

    // Death
    if (p.death_date || p.death_place) {
      let d = `${cap(name)} died`;
      if (p.death_date) d += ` on ${nice(p.death_date)}`;
      if (p.death_place) d += ` in ${p.death_place}`;
      d += ".";
      lines.push(d);
    } else if (p.living) {
      lines.push(`${cap(name)} is recorded as living.`);
    }

    // Biography free text
    if (p.biography) lines.push(p.biography);

    return lines.join(" ");
  }

  /* Chronological timeline merging the subject's life facts + events with the
   * key dates of their immediate family: parents' births and their marriage/
   * divorce, the subject's own marriages/divorces, and each child's birth and
   * marriage/divorce. Each item carries a `relation` ("self"|"parent"|"child")
   * so the view can distinguish the subject's own life from their relatives'. */
  async function timeline(personId) {
    const p = await Tree.person(personId);
    if (!p) return [];
    const fam = await Tree.family(personId);
    const items = [];
    const parentRole = (g) => g === "male" ? "Father" : g === "female" ? "Mother" : "Parent";
    const childRole  = (g) => g === "male" ? "Son" : g === "female" ? "Daughter" : "Child";

    // Subject — birth
    if (p.birth_date) items.push({ date: p.birth_date, type: "birth", relation: "self",
      text: `Born${p.birth_place ? " in " + p.birth_place : ""}` });

    // Parents — births
    for (const par of fam.parents) {
      const pp = par.person;
      if (pp.birth_date) items.push({ date: pp.birth_date, type: "birth", relation: "parent",
        text: `${parentRole(pp.gender)} ${M.fullName(pp)} born${pp.birth_place ? " in " + pp.birth_place : ""}` });
    }

    // Parents — marriage / divorce to each other
    const parentIds = new Set(fam.parents.map((x) => x.person.id));
    const seenParentM = new Set();
    for (const par of fam.parents) {
      const ms = await Data.Marriages.forPerson(par.person.id);
      for (const m of ms) {
        const otherId = m.spouse1_id === par.person.id ? m.spouse2_id : m.spouse1_id;
        if (!parentIds.has(otherId) || seenParentM.has(m.id)) continue;
        seenParentM.add(m.id);
        const other = await Tree.person(otherId);
        const pair = `${M.fullName(par.person)} and ${other ? M.fullName(other) : "their spouse"}`;
        if (m.marriage_date) items.push({ date: m.marriage_date, type: "marriage", relation: "parent",
          text: `Parents ${pair} married${m.location ? " in " + m.location : ""}` });
        if (m.divorce_date) items.push({ date: m.divorce_date, type: "divorce", relation: "parent",
          text: `Parents ${pair} divorced` });
      }
    }

    // Subject — marriages / divorces
    const marriages = await Data.Marriages.forPerson(personId);
    for (const m of marriages) {
      const otherId = m.spouse1_id === personId ? m.spouse2_id : m.spouse1_id;
      const other = await Tree.person(otherId);
      if (m.marriage_date) items.push({ date: m.marriage_date, type: "marriage", relation: "self",
        text: `Married ${other ? M.fullName(other) : "their spouse"}${m.location ? " in " + m.location : ""}` });
      if (m.divorce_date) items.push({ date: m.divorce_date, type: "divorce", relation: "self",
        text: `Divorced ${other ? M.fullName(other) : "their spouse"}` });
    }

    // Subject — custom/life events
    const events = await Data.Events.forPerson(personId);
    for (const e of events) {
      const label = e.type === "custom" ? (e.custom_label || "Event") : cap(e.type.replace("_", " "));
      items.push({ date: e.date, type: e.type, relation: "self",
        text: `${label}${e.location ? " \u2014 " + e.location : ""}${e.description ? ": " + e.description : ""}` });
    }

    // Children — births and their marriages / divorces
    for (const ch of fam.children) {
      const c = ch.person;
      if (c.birth_date) items.push({ date: c.birth_date, type: "birth", relation: "child",
        text: `${childRole(c.gender)} ${M.fullName(c)} born${c.birth_place ? " in " + c.birth_place : ""}` });
      const cms = await Data.Marriages.forPerson(c.id);
      for (const m of cms) {
        const otherId = m.spouse1_id === c.id ? m.spouse2_id : m.spouse1_id;
        const other = await Tree.person(otherId);
        if (m.marriage_date) items.push({ date: m.marriage_date, type: "marriage", relation: "child",
          text: `${M.fullName(c)} married ${other ? M.fullName(other) : "their spouse"}${m.location ? " in " + m.location : ""}` });
        if (m.divorce_date) items.push({ date: m.divorce_date, type: "divorce", relation: "child",
          text: `${M.fullName(c)} divorced ${other ? M.fullName(other) : "their spouse"}` });
      }
    }

    // Subject — death
    if (p.death_date) items.push({ date: p.death_date, type: "death", relation: "self",
      text: `Died${p.death_place ? " in " + p.death_place : ""}` });

    items.sort((a, b) => (a.date || "9999").localeCompare(b.date || "9999"));
    return items;
  }

  function listify(arr) {
    if (arr.length === 0) return "";
    if (arr.length === 1) return arr[0];
    if (arr.length === 2) return arr[0] + " and " + arr[1];
    return arr.slice(0, -1).join(", ") + ", and " + arr[arr.length - 1];
  }
  function aOrAn(word) {
    return (/^[aeiou]/i.test(word) ? "an " : "a ") + word;
  }

  FT.Story = { narrative, timeline, nice, yearOf };
})(window.FT);