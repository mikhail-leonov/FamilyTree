/* ui/editor.js — person editor: identity, dates, relationships, marriages, 
 * events, media metadata.
 * v2 changes:
 *   - Date fields are TEXT inputs accepting partial dates (YYYY, YYYY-MM,
 *     YYYY-MM-DD). Previously <input type=date> rendered imported partial
 *     dates as empty and saving silently erased them.
 *   - Explicit Living/Deceased select (previously derived only from
 *     death_date, so a known-deceased person without a date couldn't be
 *     marked deceased).
 *   - Relationship kind select offers the full spec list (6 kinds).
 *   - Marriages gain a notes field.
 *   - Media upload stores METADATA + a small generated thumbnail only; the
 *     original file never enters IndexedDB (spec).
 * ========================================================================== */
window.FT = window.FT || {};
FT.UI = FT.UI || {};

(function (FT) {
  "use strict";
  const H = FT.H, M = FT.Models, Data = FT.Data;

  /* ------------------------------------------------------------- helpers */
  function field(label, input, opts) {
    opts = opts || {};
    const id = "f-" + Math.random().toString(36).slice(2, 8);
    input.setAttribute("id", id);
    return H.el("div", { class: "ft-field" + (opts.wide ? " wide" : "") }, [
      H.el("label", { class: "ft-label", for: id }, label),
      input,
      opts.hint ? H.el("div", { class: "ft-muted ft-hint" }, opts.hint) : null
    ]);
  }
  function input(value, attrs) {
    return H.el("input", Object.assign({ class: "ft-input", type: "text", value: value || "" }, attrs || {}));
  }
  function dateInput(value) {
    return input(value, {
      placeholder: "YYYY-MM-DD or YYYY",
      inputmode: "numeric",
      pattern: "\\d{4}(-\\d{2}(-\\d{2})?)?",
      title: "Full or partial date: 1900, 1900-05, or 1900-05-17"
    });
  }
  function select(options, value, attrs) {
    const s = H.el("select", Object.assign({ class: "ft-select" }, attrs || {}));
    options.forEach((o) => {
      const opt = H.el("option", { value: o.value }, o.label);
      if (o.value === value) opt.setAttribute("selected", "selected");
      s.appendChild(opt);
    });
    return s;
  }
  function subtypeSelect(value) {
    return select(M.SUBTYPES.map((s) => ({ value: s, label: s })), value || "biological",
      { class: "ft-select sm", "aria-label": "Relationship kind" });
  }

  /* Typeahead person picker (excludes a set of ids). */
  function personPicker(placeholder, onPick, excludeIds) {
    const wrap = H.el("div", { class: "ft-picker" });
    const inp = H.el("input", { class: "ft-input", type: "search", placeholder, "aria-label": placeholder });
    const results = H.el("div", { class: "ft-picker-results floating" });
    let debounce;
    inp.addEventListener("input", () => {
      clearTimeout(debounce);
      debounce = setTimeout(async () => {
        const q = inp.value.trim();
        H.clear(results);
        if (q.length < 1) return;
        const rows = await FT.Search.search(q, { limit: 8 });
        rows.filter((p) => !(excludeIds || []).includes(p.id)).forEach((p) => {
          const item = H.el("button", { type: "button", class: "ft-picker-item" },
            M.fullName(p) + (M.lifeSpan(p) ? " (" + M.lifeSpan(p) + ")" : ""));
          item.addEventListener("click", () => { onPick(p); inp.value = ""; H.clear(results); });
          results.appendChild(item);
        });
      }, 200);
    });
    wrap.appendChild(inp);
    wrap.appendChild(results);
    return wrap;
  }

  /* Generate a small JPEG thumbnail data URL from an image file (≤ maxPx). */
  function makeThumbnail(file, maxPx) {
    return new Promise((resolve) => {
      if (!file.type.startsWith("image/")) return resolve(null);
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxPx / Math.max(img.width, img.height));
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(img.width * scale));
        c.height = Math.max(1, Math.round(img.height * scale));
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        try { resolve(c.toDataURL("image/jpeg", 0.78)); } catch (e) { resolve(null); }
      };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
      img.src = url;
    });
  }

  /* ------------------------------------------------------------- main UI */
  async function render(main, params) {
    const personId = params && params.id;
    const isNew = !personId;
    const p = isNew ? M.person({}) : await Data.Persons.get(personId);
    if (!isNew && !p) {
      main.appendChild(H.el("p", { class: "ft-muted ft-pad" }, "Person not found."));
      return;
    }

    main.appendChild(H.el("div", { class: "ft-page-head" }, [
      H.el("div", {}, [
        H.el("p", { class: "ft-eyebrow" }, isNew ? "New record" : "Edit record"),
        H.el("h1", { class: "ft-h1" }, isNew ? "Add person" : M.fullName(p))
      ]),
      H.el("div", { class: "ft-page-actions" }, isNew ? [] : [
        H.el("a", { class: "ft-btn ghost", href: "#/tree/" + p.id }, "View in tree"),
        H.el("a", { class: "ft-btn ghost", href: "#/story/" + p.id }, "Story")
      ])
    ]));

    /* ---- identity form ---- */
    const f = {
      first: input(p.first_name), middle: input(p.middle_name), last: input(p.last_name),
      maiden: input(p.maiden_name), nick: input(p.nickname),
      gender: select(M.GENDERS.map((g) => ({ value: g, label: g })), p.gender),
      birth: dateInput(p.birth_date), death: dateInput(p.death_date),
      living: select([{ value: "1", label: "living" }, { value: "0", label: "deceased" }], p.living ? "1" : "0"),
      birthPlace: input(p.birth_place), deathPlace: input(p.death_place), residence: input(p.residence),
      occupation: input(p.occupation), education: input(p.education),
      biography: H.el("textarea", { class: "ft-input", rows: 5 }),
      notes: H.el("textarea", { class: "ft-input", rows: 3 }),
      burialPlace: input(p.burial_place),
      causeOfDeath: input(p.cause_of_death),
      email: input(p.email),
      marriedName: input(p.married_name),
      upd: input(p.upd, { readonly: true }),
      uid: input(p.uid, { readonly: true }),
      rin: input(p.rin, { readonly: true })
    };

    f.biography.value = p.biography || "";
    f.notes.value = p.notes || "";

    const form = H.el("div", { class: "ft-card ft-pad" }, [
      H.el("h2", { class: "ft-h2" }, "Identity"),
      H.el("div", { class: "ft-form-grid" }, [
        field("First name", f.first), field("Middle name", f.middle), field("Last name", f.last),
        field("Maiden name", f.maiden), field("Nickname", f.nick), field("Gender", f.gender),
        field("Birth date", f.birth, { hint: "Partial dates welcome: 1900 or 1900-05" }),
        field("Death date", f.death, { hint: "Leave blank if living or unknown" }),
        field("Status", f.living, { hint: "Used when no death date is recorded" }),
        field("Birthplace", f.birthPlace), field("Place of death", f.deathPlace), field("Residence", f.residence),
        field("Occupation", f.occupation), field("Education", f.education),
        field("Biography", f.biography, { wide: true }),
        field("Research notes", f.notes, { wide: true }),
        field("Burial place", f.burialPlace),
        field("Cause of death", f.causeOfDeath),
        field("Email", f.email),
        field("Married name", f.marriedName),
        field("MyHeritage UPD", f.upd, { hint: "read‑only" }),
        field("MyHeritage UID", f.uid),
        field("MyHeritage RIN", f.rin)
      ])
    ]);

    const saveBtn = H.el("button", { class: "ft-btn" }, isNew ? "Add person" : "Save changes");
    const actions = H.el("div", { class: "ft-form-actions" }, [saveBtn]);
    if (!isNew) {
      const delBtn = H.el("button", { class: "ft-btn danger" }, "Delete\u2026");
      delBtn.addEventListener("click", async () => {
        if (!H.confirm("Move " + M.fullName(p) + " to the trash? Their relationships, marriages and media links go with them. You can restore from Import / Export \u2192 Trash, or press Undo.")) return;
        try {
          await Data.Persons.remove(p.id);
          H.toast("Moved to trash \u2014 undo available", "success");
          H.go("#/people");
        } catch (e) { H.toast(e.message, "error"); }
      });
      actions.appendChild(delBtn);
    }
    form.appendChild(actions);
    main.appendChild(form);

    saveBtn.addEventListener("click", async () => {
      const data = {
        id: isNew ? undefined : p.id,
        tree_id: p.tree_id || FT.State.activeTreeId,
        first_name: f.first.value, middle_name: f.middle.value, last_name: f.last.value,
        maiden_name: f.maiden.value, nickname: f.nick.value, gender: f.gender.value,
        birth_date: f.birth.value.trim(), death_date: f.death.value.trim(),
        living: f.living.value === "1",
        birth_place: f.birthPlace.value, death_place: f.deathPlace.value, residence: f.residence.value,
        occupation: f.occupation.value, education: f.education.value,
        biography: f.biography.value, notes: f.notes.value,
        profile_photo_id: p.profile_photo_id, created: p.created
      };
      try {
        const saved = await Data.Persons.save(data);
        H.toast(isNew ? "Person added" : "Saved", "success");
        if (isNew) H.go("#/person/" + saved.id);
        else FT.Router.dispatch();
      } catch (e) { H.toast(e.message, "error"); }
    });

    if (isNew) return; // relationship/marriage/event/media sections need an id

    /* ---- relationships ---- */
    const fam = await FT.Tree.family(p.id);
    const relCard = H.el("div", { class: "ft-card ft-pad" }, [H.el("h2", { class: "ft-h2" }, "Family links")]);

    function relRow(label, other, subtype, removeFn) {
      return H.el("div", { class: "ft-rel-row" }, [
        H.el("span", { class: "ft-tag " + (subtype || "") }, label + (subtype && subtype !== "biological" ? " \u00b7 " + subtype : "")),
        H.el("a", { href: "#/person/" + other.id, class: "ft-link-strong" }, M.fullName(other)),
        H.el("span", { class: "ft-muted" }, M.lifeSpan(other)),
        (function () {
          const b = H.el("button", { class: "ft-x", title: "Remove link", "aria-label": "Remove link to " + M.fullName(other) }, "\u00d7");
          b.addEventListener("click", removeFn);
          return b;
        })()
      ]);
    }

    const relList = H.el("div", { class: "ft-rel-list" });
    fam.parents.forEach((x) => relList.appendChild(relRow("Parent", x.person, x.subtype, async () => {
      if (!H.confirm("Remove parent link to " + M.fullName(x.person) + "?")) return;
      await Data.Relationships.removeEdge(x.person.id, p.id); FT.Router.dispatch();
    })));
    fam.children.forEach((x) => relList.appendChild(relRow("Child", x.person, x.subtype, async () => {
      if (!H.confirm("Remove child link to " + M.fullName(x.person) + "?")) return;
      await Data.Relationships.removeEdge(p.id, x.person.id); FT.Router.dispatch();
    })));
    fam.siblings.forEach((s) => relList.appendChild(H.el("div", { class: "ft-rel-row" }, [
      H.el("span", { class: "ft-tag " + (s.half ? "half" : "full") }, s.half ? "Half-sibling" : "Sibling"),
      H.el("a", { href: "#/person/" + s.person.id, class: "ft-link-strong" }, M.fullName(s.person)),
      H.el("span", { class: "ft-muted" }, "derived from shared parents")
    ])));
    if (!relList.children.length) relList.appendChild(H.el("p", { class: "ft-muted" }, "No family links yet."));
    relCard.appendChild(relList);

    const addKindParent = subtypeSelect();
    const addParent = personPicker("Add a parent\u2026", async (other) => {
      try { await Data.Relationships.addParentChild(other.id, p.id, addKindParent.value); FT.Router.dispatch(); }
      catch (e) { H.toast(e.message, "error"); }
    }, [p.id]);
    const addKindChild = subtypeSelect();
    const addChild = personPicker("Add a child\u2026", async (other) => {
      try { await Data.Relationships.addParentChild(p.id, other.id, addKindChild.value); FT.Router.dispatch(); }
      catch (e) { H.toast(e.message, "error"); }
    }, [p.id]);
    relCard.appendChild(H.el("div", { class: "ft-rel-grid" }, [
      H.el("div", { class: "ft-add-row" }, [addParent, addKindParent]),
      H.el("div", { class: "ft-add-row" }, [addChild, addKindChild])
    ]));
    main.appendChild(relCard);

    /* ---- marriages ---- */
    const marCard = H.el("div", { class: "ft-card ft-pad" }, [H.el("h2", { class: "ft-h2" }, "Marriages & partnerships")]);
    const marriages = await Data.Marriages.forPerson(p.id);
    for (const m of marriages) {
      const otherId = m.spouse1_id === p.id ? m.spouse2_id : m.spouse1_id;
      const other = await Data.Persons.get(otherId);
      const md = dateInput(m.marriage_date), dd = dateInput(m.divorce_date), loc = input(m.location);
      const notes = input(m.notes, { placeholder: "Notes" });
      const save = H.el("button", { class: "ft-btn sm" }, "Save");
      const rm = H.el("button", { class: "ft-x", title: "Remove marriage record" }, "\u00d7");
      save.addEventListener("click", async () => {
        try {
          await Data.Marriages.save(Object.assign({}, m, {
            marriage_date: md.value.trim(), divorce_date: dd.value.trim(),
            location: loc.value, notes: notes.value
          }));
          H.toast("Marriage updated", "success");
        } catch (e) { H.toast(e.message, "error"); }
      });
      rm.addEventListener("click", async () => {
        if (!H.confirm("Remove this marriage record?")) return;
        await Data.Marriages.remove(m.id); FT.Router.dispatch();
      });
      marCard.appendChild(H.el("div", { class: "ft-marriage" }, [
        H.el("div", { class: "ft-marriage-head" }, [
          H.el("a", { href: "#/person/" + otherId, class: "ft-link-strong" }, other ? M.fullName(other) : "Unknown"),
          m.divorce_date ? H.el("span", { class: "ft-tag" }, "divorced") : H.el("span", { class: "ft-tag full" }, "active"),
          rm
        ]),
        H.el("div", { class: "ft-marriage-meta ft-form-grid" }, [
          field("Married", md), field("Divorced", dd), field("Location", loc), field("Notes", notes)
        ]),
        save
      ]));
    }
    const addSpouseDate = dateInput("");
    const addSpouse = personPicker("Add a spouse / partner\u2026", async (other) => {
      try {
        await Data.Marriages.save({ spouse1_id: p.id, spouse2_id: other.id, marriage_date: addSpouseDate.value.trim() });
        FT.Router.dispatch();
      } catch (e) { H.toast(e.message, "error"); }
    }, [p.id]);
    marCard.appendChild(H.el("div", { class: "ft-add-row ft-add-marriage" }, [addSpouse, addSpouseDate]));
    main.appendChild(marCard);

    /* ---- events ---- */
    const evCard = H.el("div", { class: "ft-card ft-pad" }, [H.el("h2", { class: "ft-h2" }, "Life events")]);
    const events = (await Data.Events.forPerson(p.id))
      .sort((a, b) => (a.date || "9999").localeCompare(b.date || "9999"));
    events.forEach((ev) => {
      const rm = H.el("button", { class: "ft-x", title: "Remove event" }, "\u00d7");
      rm.addEventListener("click", async () => {
        if (!H.confirm("Remove this event?")) return;
        await Data.Events.remove(ev.id); FT.Router.dispatch();
      });
      evCard.appendChild(H.el("div", { class: "ft-event-row" }, [
        H.el("span", { class: "ft-event-type" }, ev.type === "custom" ? (ev.custom_label || "custom") : ev.type.replace("_", " ")),
        H.el("span", { class: "ft-event-date" }, ev.date || "undated"),
        H.el("span", { class: "ft-event-desc" }, [ev.location, ev.description].filter(Boolean).join(" \u2014 ")),
        rm
      ]));
    });
    const evType = select(M.EVENT_TYPES.filter((t) => !["birth", "death", "marriage", "divorce"].includes(t))
      .map((t) => ({ value: t, label: t.replace("_", " ") })), "custom", { class: "ft-select sm" });
    const evLabel = input("", { placeholder: "Custom label" });
    const evDate = dateInput("");
    const evLoc = input("", { placeholder: "Location" });
    const evDesc = input("", { placeholder: "Description" });
    const evAdd = H.el("button", { class: "ft-btn sm" }, "Add event");
    evAdd.addEventListener("click", async () => {
      try {
        if (!M.isValidPartialDate(evDate.value.trim())) throw new Error("Event date must be YYYY, YYYY-MM, or YYYY-MM-DD.");
        await Data.Events.save({
          type: evType.value, custom_label: evLabel.value, date: evDate.value.trim(),
          location: evLoc.value, description: evDesc.value, people: [p.id]
        });
        FT.Router.dispatch();
      } catch (e) { H.toast(e.message, "error"); }
    });
    evCard.appendChild(H.el("div", { class: "ft-add-row wrap" }, [evType, evLabel, evDate, evLoc, evDesc, evAdd]));
    main.appendChild(evCard);

    /* ---- media (metadata + thumbnail only) ---- */
    const mediaCard = H.el("div", { class: "ft-card ft-pad" }, [
      H.el("h2", { class: "ft-h2" }, "Photos & documents"),
      H.el("p", { class: "ft-muted" },
        "Only file details and a small preview are kept in the database \u2014 original files stay on your computer.")
    ]);
    const mediaList = await Data.Media.forPerson(p.id);
    const gallery = H.el("div", { class: "ft-gallery" });
    mediaList.forEach((m) => {
      const rm = H.el("button", { class: "ft-x", title: "Remove media reference" }, "\u00d7");
      rm.addEventListener("click", async () => {
        if (!H.confirm("Remove this media reference?")) return;
        if (p.profile_photo_id === m.id) await Data.Persons.save(Object.assign({}, p, { profile_photo_id: null }));
        await Data.Media.remove(m.id);
        FT.Router.dispatch();
      });
      const setProfile = H.el("button", { class: "ft-chip" }, p.profile_photo_id === m.id ? "Profile \u2713" : "Set as profile");
      setProfile.addEventListener("click", async () => {
        await Data.Persons.save(Object.assign({}, p, { profile_photo_id: m.id }));
        FT.Router.dispatch();
      });
      gallery.appendChild(H.el("figure", { class: "ft-media-tile" + (p.profile_photo_id === m.id ? " profile" : "") }, [
        m.thumbnail
          ? H.el("img", { src: m.thumbnail, alt: m.description || m.name })
          : H.el("div", { class: "ft-doc" }, "\u{1F4C4}"),
        H.el("figcaption", {}, [
          H.el("div", { class: "ft-media-name" }, m.name || "untitled"),
          H.el("div", { class: "ft-muted" }, [
            m.mime, m.size ? Math.round(m.size / 1024) + " KB" : null,
            m.tags && m.tags.length ? "#" + m.tags.join(" #") : null
          ].filter(Boolean).join(" \u00b7 ")),
          m.description ? H.el("div", { class: "ft-muted" }, m.description) : null,
          H.el("div", { class: "ft-media-actions" }, m.kind === "image" || m.thumbnail ? [setProfile, rm] : [rm])
        ])
      ]));
    });
    if (!mediaList.length) gallery.appendChild(H.el("p", { class: "ft-muted" }, "No media yet."));
    mediaCard.appendChild(gallery);

    const file = H.el("input", { type: "file", class: "ft-file", accept: "image/*,.pdf,.txt,.doc,.docx", "aria-label": "Add photo or document" });
    const tagsIn = input("", { placeholder: "tags, comma separated" });
    const descIn = input("", { placeholder: "Description" });
    const upBtn = H.el("button", { class: "ft-btn sm" }, "Add reference");
    upBtn.addEventListener("click", async () => {
      const fobj = file.files && file.files[0];
      if (!fobj) { H.toast("Choose a file first", "error"); return; }
      const isImage = fobj.type.startsWith("image/");
      const thumb = isImage ? await makeThumbnail(fobj, 240) : null;
      try {
        await Data.Media.save({
          person_id: p.id, kind: isImage ? "image" : "document",
          name: fobj.name, mime: fobj.type || "application/octet-stream", size: fobj.size,
          tags: tagsIn.value.split(",").map((t) => t.trim()).filter(Boolean),
          description: descIn.value, thumbnail: thumb
        });
        H.toast("Media reference added", "success");
        FT.Router.dispatch();
      } catch (e) { H.toast(e.message, "error"); }
    });
    mediaCard.appendChild(H.el("div", { class: "ft-upload" }, [file, tagsIn, descIn, upBtn]));
    main.appendChild(mediaCard);
  }
  FT.UI.Editor = { render, renderNew: (main) => render(main, undefined) };
})(window.FT);
