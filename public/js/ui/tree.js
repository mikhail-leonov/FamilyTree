/* ============================================================================ 
 * ui/tree.js — interactive CANVAS family-tree workspace.
 *
 * This is the page controller that wires the data layer (FT.Tree.focusGraph)
 * into the canvas engine (FT.TreeRenderer) and the surrounding UI. It replaces
 * an earlier broken stub that drew nodes at random positions and never mounted
 * its panel; everything below uses the real renderer.
 *
 * Requirements covered here:
 *   - Req 4: a SYNCHRONIZED left editor panel. Clicking a person node loads
 *     their full record into an inline, immediately-editable form; the node is
 *     highlighted; exactly one person is selected at a time; saving updates the
 *     tree in place (same UUID, no rebuild of the whole graph view).
 *   - Req 5: a full-width workspace (fixed side panel + a flex-filled canvas
 *     stage) that resizes with the window / panel.
 *   - Req 6/7: per-node ancestor indicators are fed from the data layer; the
 *     ancestor indicator (and Enter) re-centre the tree on a branch WITHOUT
 *     losing the currently selected person.
 *   - Parent Expansion Indicator: a card whose parents are not yet on screen
 *     shows a reveal control; clicking it pulls the hidden parent layer in
 *     incrementally, preserving the current view (no full reset, no duplicates).
 *     The reveal is PER-PERSON: clicking one card's parent tab pulls in only
 *     that person's parents, not every node sharing the same generation.
 *
 *   - Persist the current focus person across sessions. The last focused
 *     person ID is stored in IndexedDB metadata under key "last_focus_person".
 *     When the tree page loads, it restores that focus; when the user changes
 *     focus (via search, ancestor click, Enter key, or depth changes), the new
 *     focus is saved automatically.
 *
 *   - Quick "add relative" actions, available BOTH in the side editor panel and
 *     directly ON each person card (rendered by the canvas engine: parent on
 *     the top edge, child on the bottom edge, spouse on the right edge). All
 *     entry points create a brand-new person, link them in the database, and
 *     bind the new person to the editor for naming. "Add parent" is hidden once
 *     the person already has two parents on record — both in the side panel and
 *     on the card (driven by the per-node parentCounts map fed to the renderer).
 *
 * NOTE: siblings are never linked to each other — the renderer routes every
 * sibling connector up to the shared parent pair, satisfying the acceptance
 * criterion that sibling groups connect through parent nodes only.
 * ========================================================================== */
window.FT = window.FT || {};
FT.UI = FT.UI || {};
(function (FT) {
  "use strict";
  const H = FT.H, M = FT.Models, Tree = FT.Tree, Data = FT.Data, DB = FT.DB;
  /* Gather every person id present in a focus graph so we can ask the data
   * layer, in one pass, how many parents each of them has on record. The
   * renderer uses this to draw the correct ancestor indicator AND to decide
   * which cards may add/reveal parents — even for frontier / in-law nodes whose
   * parents were never loaded into the bounded graph. */
  function collectGraphIds(graph) {
    const ids = new Set([graph.root.id]);
    graph.ancestors.nodes.forEach((_, id) => ids.add(id));
    graph.descendants.nodes.forEach((_, id) => ids.add(id));
    (graph.coParents || []).forEach((p) => ids.add(p.id));
    (graph.siblings || []).forEach((s) => ids.add(s.person.id));
    (graph.spouses || []).forEach((s) => ids.add(s.person.id));
    return Array.from(ids);
  }
  // ✅ restore last focused person from metadata, not "seed_root"
  async function resolveFocusId(paramId) {
    if (paramId) return paramId;
    const meta = await DB.get("metadata", "last_focus_person");
    if (meta && meta.value) {
      const p = await Data.Persons.get(meta.value);
      if (p) return meta.value;
    }
    const any = await DB.byIndex(
      "persons", "tree_id", IDBKeyRange.only(FT.State.activeTreeId), 1
    );
    return any[0] && any[0].id;
  }
  // persist the given person id as the last focused person
  async function saveFocusPerson(personId) {
    if (!personId) return;
    await DB.put("metadata", { key: "last_focus_person", value: personId });
  }
  async function render(main, params) {
    const focusId0 = await resolveFocusId(params && params.id);
    if (!focusId0) {
      await renderEmptyState(main);
      return;
    }
    // ── page state ─────────────────────────────────────────────────────────
    const ui = {
      focusId: focusId0,
      selectedId: focusId0,          // the person bound to the side editor (Req 4)
      cfg: { up: 4, down: 2 },        // ancestor / descendant depth
      view: { showSiblings: true, showHalf: true, showSpouses: true, showEx: true },
      expanded: new Set(),            // people whose parents were manually revealed
      firstPaint: true
    };
    // toolbar: focus search · depth · view toggles · zoom
    const focusSearch = H.el("input", { class: "ft-input", type: "search",
      placeholder: "Focus on a person\u2026", "aria-label": "Focus on a person" });
    const focusResults = H.el("div", { class: "ft-picker-results floating" });
    const upCtl = depthControl("Ancestors", ui.cfg.up, (v) => { ui.cfg.up = v; refresh(); });
    const downCtl = depthControl("Descendants", ui.cfg.down, (v) => { ui.cfg.down = v; refresh(); });
    const toggles = H.el("div", { class: "ft-tree-toggles" }, [
      viewToggle("Siblings", "showSiblings"),
      viewToggle("Half", "showHalf"),
      viewToggle("Spouses", "showSpouses"),
      viewToggle("Former", "showEx")
    ]);
    const toolbar = H.el("div", { class: "ft-tree-toolbar" }, [
      H.el("div", { class: "ft-focus-search" }, [focusSearch, focusResults]),
      upCtl.el, downCtl.el, toggles,
      H.el("div", { class: "ft-zoom" }, [
        zbtn("\u2212", () => renderer.zoomOut()),
        zbtn("Fit", () => renderer.reset(), true),
        zbtn("+", () => renderer.zoomIn()),
        zbtn("Expand", () => renderer.expandAll(), true)
      ])
    ]);
    main.appendChild(toolbar);
    // ── Req 5: full-width workspace = side editor panel + flex canvas stage ──
    const editorPanel = H.el("div", { class: "ft-tree-editor" });
    const stage = H.el("div", { class: "ft-tree-stage" });
    main.appendChild(H.el("div", { class: "ft-tree-workspace" }, [editorPanel, stage]));
    // aria-live announcements for keyboard / indicator navigation
    const live = H.el("div", { class: "ft-visually-hidden", "aria-live": "polite" });
    main.appendChild(live);
    /* ------------------------------ renderer ------------------------------ */
    const renderer = FT.TreeRenderer.create(stage, {
      onAnnounce: (msg) => { live.textContent = msg; },
      // Req 4: selecting a node binds it to the side editor.
      onSelect: (id) => { ui.selectedId = id; loadEditor(id); },
      // Req 7: ancestor indicator / Enter re-centres on a person but keeps the
      // currently selected person (editor) intact.
      onNavigate: (id) => {
        ui.focusId = id;
        ui.expanded.clear();   // per-person reveals are local to the focus tree
        // persist focus when user navigates via ancestor indicator or Enter
        saveFocusPerson(id);
        refresh({ keepSelection: true });
      },
      // Parent Expansion Indicator: reveal THIS card's hidden parents in place.
      onExpandParents: (id) => {
        // Reveal ONLY this person's parents. We do NOT bump the global ancestor
        // depth (that would pull in every other frontier node's parents too);
        // instead we add this person to the `expanded` set, which the data layer
        // walks one extra generation up from — for this person alone.
        ui.expanded.add(id);
        refresh({ keepSelection: true, keepView: true });
      },
      // On-card quick-add controls (parent top / child bottom / spouse right).
      onAddRelative: async (id, kind) => {
        const person = await Data.Persons.get(id);
        if (person) await addRelative(kind, person);
      }
    });
    /* teardown: drop the renderer's window-level listeners when we leave. */
    function teardown() {
      try { renderer.destroy(); } catch (_) {}
      window.removeEventListener("hashchange", onHashChange);
    }
    function onHashChange() {
      const path = (location.hash.split("?")[0]) || "";
      if (!path.startsWith("#/tree")) teardown();
    }
    window.addEventListener("hashchange", onHashChange);
    /* --------------------------- focus search --------------------------- */
    let deb;
    focusSearch.addEventListener("input", () => {
      clearTimeout(deb);
      deb = setTimeout(async () => {
        H.clear(focusResults);
        if (!focusSearch.value.trim()) return;
        const found = await FT.Search.search(focusSearch.value, { limit: 8 });
        found.forEach((p) => {
          const b = H.el("button", { class: "ft-picker-item" },
            M.fullName(p) + (M.lifeSpan(p) ? " (" + M.lifeSpan(p) + ")" : ""));
          b.addEventListener("click", () => {
            ui.focusId = p.id; ui.selectedId = p.id;
            ui.expanded.clear();   // per-person reveals are local to the focus tree
            // persist focus when search selection changes
            saveFocusPerson(p.id);
            focusSearch.value = ""; H.clear(focusResults);
            refresh();
          });
          focusResults.appendChild(b);
        });
      }, 200);
    });
    /* ------------------------------ refresh ------------------------------ */
    async function refresh(o) {
      o = o || {};
      const graph = await Tree.focusGraph(ui.focusId, ui.cfg.up, ui.cfg.down, ui.expanded);
      if (!graph) return;
      // ensure the focus person is saved every time we refresh
      // (covers depth changes, parent expansions, etc.)
      await saveFocusPerson(ui.focusId);
      const ids = collectGraphIds(graph);
      // One pass over the bounded graph's people: how many parents AND children
      // each has on record. Parent count drives the ancestor indicator
      // (hasAnc = count > 0) and the "add parent" limitation (hidden at >= 2);
      // child count drives the hidden-children navigation tab.
      const parentCounts = {};
      const childCounts = {};
      for (const id of ids) {
        const pEdges = await Data.Relationships.parentsOf(id);
        parentCounts[id] = pEdges.length;
        const cEdges = await Data.Relationships.childrenOf(id);
        childCounts[id] = cEdges.length;
      }
      const ancestorMap = {};
      const descendantMap = {};
      ids.forEach((id) => {
        ancestorMap[id] = parentCounts[id] > 0;
        descendantMap[id] = childCounts[id] > 0;
      });
      renderer.render(graph, ui.view, { ancestorMap, descendantMap, parentCounts, childCounts });
      // Recenter on focus / depth changes; preserve the current view for
      // in-place edits (save, parent-reveal) so the user keeps their place.
      if (ui.firstPaint) ui.firstPaint = false;      // renderer fits on first paint
      else if (!o.keepView) renderer.reset();        // animate-fit to the new focus
      // keep highlight + side editor in sync with the selected person
      if (!o.keepSelection) ui.selectedId = ui.focusId;
      renderer.select(ui.selectedId);
      await loadEditor(ui.selectedId);
      history.replaceState(null, "", "#/tree/" + ui.focusId);
    }
    /* ----------------------- add-relative quick actions ----------------------- */
    // Create a brand-new related person, link them, then select them for editing.
    // Shared by the side-panel buttons and the renderer's on-card "+" controls.
    async function addRelative(kind, person) {
      try {
        // Adding a spouse or child is allowed no matter whether `person` is
        // deceased — the relationship/marriage services impose no living check.
        // The NEW relative defaults to LIVING (not auto-marked dead); flip to
        // "deceased" in the editor for historical relatives.
        const base = { tree_id: person.tree_id, first_name: "New person", living: true };
        // Children and parents conventionally share the family surname.
        if ((kind === "child" || kind === "parent") && person.last_name) {
          base.last_name = person.last_name;
        }
        const created = await Data.Persons.save(base);
        if (kind === "child") {
          await Data.Relationships.addParentChild(person.id, created.id, "biological");
        } else if (kind === "parent") {
          await Data.Relationships.addParentChild(created.id, person.id, "biological");
        } else if (kind === "spouse") {
          await Data.Marriages.save({ spouse1_id: person.id, spouse2_id: created.id });
        }
        ui.selectedId = created.id;          // bind the new person to the editor
        H.toast("Added a new " + kind + " \u2014 edit their details.", "success");
        await refresh({ keepSelection: true, keepView: true });
      } catch (e) {
        H.toast(e.message || ("Could not add " + kind + "."), "error");
      }
    }
    /* --------------------- Req 4: synchronized editor --------------------- */
    async function loadEditor(personId) {
      const p = personId ? await Data.Persons.get(personId) : null;
      H.clear(editorPanel);
      if (!p) {
        editorPanel.appendChild(H.el("div", { class: "ft-tree-editor-empty" }, [
          H.el("p", { class: "ft-eyebrow" }, "No selection"),
          H.el("p", { class: "ft-muted" },
            "Click a person in the tree to view and edit their details here.")
        ]));
        return;
      }
      const fields = {};
      const input = (key, val, attrs) =>
        (fields[key] = H.el("input", Object.assign(
          { class: "ft-input", type: "text", value: val == null ? "" : val }, attrs || {})));
      const field = (label, node, wide) =>
        H.el("div", { class: "ft-field" + (wide ? " wide" : "") },
          [H.el("label", { class: "ft-label" }, label), node]);
      const genderSel = H.el("select", { class: "ft-select" },
        M.GENDERS.map((g) => H.el("option",
          Object.assign({ value: g }, g === p.gender ? { selected: "selected" } : {}),
          g.charAt(0).toUpperCase() + g.slice(1))));
      fields.gender = genderSel;
      const livingSel = H.el("select", { class: "ft-select" }, [
        H.el("option", Object.assign({ value: "true" }, p.living ? { selected: "selected" } : {}), "Living"),
        H.el("option", Object.assign({ value: "false" }, p.living ? {} : { selected: "selected" }), "Deceased")
      ]);
      fields.living = livingSel;
      const notes = H.el("textarea", { class: "ft-input" }, p.notes || "");
      fields.notes = notes;
      const saveBtn = H.el("button", { class: "ft-btn" }, "Save");
      const recenterBtn = H.el("button", { class: "ft-btn ghost" }, "Center on tree");
      saveBtn.addEventListener("click", async () => {
        try {
          const updated = await Data.Persons.save({
            id: p.id, tree_id: p.tree_id, created: p.created,
            first_name: fields.first.value,
            middle_name: fields.middle.value,
            last_name: fields.last.value,
            maiden_name: fields.maiden.value,
            nickname: fields.nick.value,
            gender: fields.gender.value,
            birth_date: fields.birth.value,
            death_date: fields.death.value,
            living: fields.living.value === "true",
            birth_place: fields.birthPlace.value,
            occupation: fields.occupation.value,
            notes: fields.notes.value,
            // preserve fields not exposed in this compact panel
            death_place: p.death_place, residence: p.residence,
            biography: p.biography, education: p.education,
            profile_photo_id: p.profile_photo_id
          });
          H.toast("Saved " + M.fullName(updated) + ".", "success");
          // update in place: rebuild the bounded graph but keep view + selection
          refresh({ keepSelection: true, keepView: true });
        } catch (e) {
          H.toast(e.message || "Could not save.", "error");
        }
      });
      recenterBtn.addEventListener("click", () => {
        ui.focusId = p.id;
        ui.expanded.clear();     // per-person reveals are local to the focus tree
        saveFocusPerson(p.id);   // persist when "Center on tree" is clicked
        refresh({ keepSelection: true });
      });
      // ── Delete the selected person ───────────────────────────────────────
      // Removes the person and every reference to them (parent/child links,
      // marriages, events, media). If the focus itself is deleted, the view
      // re-centres on a relative (or any remaining person); if no one is left,
      // it returns to the dashboard.
      const deleteBtn = H.el("button", { class: "ft-btn danger sm" }, "Delete\u2026");
      deleteBtn.addEventListener("click", async () => {
        if (!H.confirm("Delete " + M.fullName(p) +
          "? Their parent/child links, marriages, events and media references are removed too. This cannot be undone.")) return;
        // Pick where to land BEFORE removing (a relative reads best).
        let fallbackId = null;
        try {
          const fam = await Tree.family(p.id);
          const cand =
            (fam.parents[0]  && fam.parents[0].person)  ||
            (fam.children[0] && fam.children[0].person) ||
            (fam.spouses[0]  && fam.spouses[0].person)  ||
            (fam.siblings[0] && fam.siblings[0].person);
          if (cand) fallbackId = cand.id;
        } catch (_) {}
        try {
          await Data.Persons.remove(p.id);
        } catch (e) {
          H.toast(e.message || "Could not delete.", "error");
          return;
        }
        H.toast(M.fullName(p) + " deleted.", "success");
        // If the focus itself was deleted, move to a relative / any survivor.
        if (ui.focusId === p.id) {
          if (!fallbackId) {
            const any = await DB.byIndex("persons", "tree_id",
              IDBKeyRange.only(FT.State.activeTreeId), 1);
            fallbackId = any[0] && any[0].id;
          }
          ui.focusId = fallbackId || null;
        }
        ui.selectedId = ui.focusId;            // the deleted person is gone
        ui.expanded.clear();                   // reveals are local to the focus tree
        if (!ui.focusId) {                      // tree is now empty
          teardown();
          H.go("#/dashboard");
          return;
        }
        await saveFocusPerson(ui.focusId);
        refresh();
      });
      // ── Add-relative quick actions (side panel) ──────────────────────────
      // Count existing parents so "Add parent" disappears once both are set
      // (same limitation as the on-card top control).
      const parentEdges = await Data.Relationships.parentsOf(p.id);
      const hasBothParents = parentEdges.length >= 2;

      const addChildBtn  = H.el("button", { class: "ft-btn ghost sm" }, "+ Child");
      const addSpouseBtn = H.el("button", { class: "ft-btn ghost sm" }, "+ Spouse");
      addChildBtn.addEventListener("click", () => addRelative("child", p));
      addSpouseBtn.addEventListener("click", () => addRelative("spouse", p));

      const addRow = [addChildBtn, addSpouseBtn];
      if (!hasBothParents) {
        const addParentBtn = H.el("button", { class: "ft-btn ghost sm" }, "+ Parent");
        addParentBtn.addEventListener("click", () => addRelative("parent", p));
        addRow.push(addParentBtn);
      }
      editorPanel.appendChild(H.el("div", { class: "ft-tree-editor-card" }, [
        H.el("p", { class: "ft-eyebrow" }, "Selected person"),
        H.el("h3", { class: "ft-h3" }, M.fullName(p)),
        H.el("p", { class: "ft-muted" },
          [M.lifeSpan(p), p.occupation, p.birth_place].filter(Boolean).join(" \u00b7 ")),
        H.el("div", { class: "ft-focus-links" }, [
          H.el("a", { class: "ft-chip", href: "#/person/" + p.id }, "Full edit"),
          H.el("a", { class: "ft-chip", href: "#/story/" + p.id }, "Story")
        ]),
        H.el("div", { class: "ft-form-grid compact" }, [
          field("First name", input("first", p.first_name)),
          field("Last name", input("last", p.last_name)),
          field("Middle name", input("middle", p.middle_name)),
          field("Maiden name", input("maiden", p.maiden_name)),
          field("Nickname", input("nick", p.nickname)),
          field("Gender", genderSel),
          field("Birth date", input("birth", p.birth_date, { placeholder: "YYYY-MM-DD" })),
          field("Death date", input("death", p.death_date, { placeholder: "YYYY-MM-DD" })),
          field("Status", livingSel),
          field("Birthplace", input("birthPlace", p.birth_place), true),
          field("Occupation", input("occupation", p.occupation), true),
          field("Notes", notes, true)
        ]),
        H.el("div", { class: "ft-form-actions" }, [saveBtn, recenterBtn, deleteBtn]),
        H.el("div", { class: "ft-form-actions ft-add-relatives" }, addRow)
      ]));
    }
    /* --------------------------- small controls --------------------------- */
    function viewToggle(label, key) {
      const cb = H.el("input", Object.assign({ type: "checkbox" },
        ui.view[key] ? { checked: "checked" } : {}));
      cb.addEventListener("change", () => {
        ui.view[key] = cb.checked;
        renderer.setViewCfg({ [key]: cb.checked });
      });
      return H.el("label", { class: "ft-toggle" }, [cb, H.el("span", {}, label)]);
    }
    // first paint
    refresh();
  }
  /* --------------------------- module helpers --------------------------- */
  function depthControl(label, val, onChange) {
    let cur = val;
    const out = H.el("span", { class: "ft-depth-val" }, String(cur));
    const minus = H.el("button", { class: "ft-zbtn",
      onclick: () => { if (cur > 0) { cur--; out.textContent = cur; onChange(cur); } } }, "\u2212");
    const plus = H.el("button", { class: "ft-zbtn",
      onclick: () => { if (cur < 8) { cur++; out.textContent = cur; onChange(cur); } } }, "+");
    return {
      el: H.el("div", { class: "ft-depth" },
        [H.el("span", { class: "ft-depth-label" }, label), minus, out, plus]),
      set: (v) => { cur = v; out.textContent = String(v); }
    };
  }
  function zbtn(label, fn, wide) {
    return H.el("button", { class: "ft-zbtn" + (wide ? " wide" : ""), onclick: fn }, label);
  }

  /* Empty-tree state: a single button-driven form that names the tree AND
   * captures the first person, then creates both and drops into the workspace
   * focused on that person. Lives on the tree page (not in Import/Export). */
  async function renderEmptyState(main) {
    const tree = await DB.get("trees", FT.State.activeTreeId);

    const fields = {};
    const input = (key, attrs) =>
      (fields[key] = H.el("input", Object.assign({ class: "ft-input", type: "text" }, attrs || {})));
    const field = (label, node, wide) =>
      H.el("div", { class: "ft-field" + (wide ? " wide" : "") },
        [H.el("label", { class: "ft-label" }, label), node]);

    const treeName = input("treeName", { value: (tree && tree.name) || "", placeholder: "e.g. Smith Family" });
    const genderSel = H.el("select", { class: "ft-select" },
      M.GENDERS.map((g) => H.el("option", { value: g }, g.charAt(0).toUpperCase() + g.slice(1))));
    fields.gender = genderSel;
    const livingSel = H.el("select", { class: "ft-select" }, [
      H.el("option", { value: "true", selected: "selected" }, "Living"),
      H.el("option", { value: "false" }, "Deceased")
    ]);
    fields.living = livingSel;
    const notes = H.el("textarea", { class: "ft-input" }, "");
    fields.notes = notes;

    const createBtn = H.el("button", { class: "ft-btn" }, "Create tree & add first person");
    createBtn.addEventListener("click", async () => {
      const first = fields.first.value.trim();
      const last = fields.last.value.trim();
      const maiden = fields.maiden.value.trim();
      const nick = fields.nick.value.trim();
      if (!first && !last && !maiden && !nick) {
        H.toast("Enter at least one name for the first person.", "error");
        fields.first.focus();
        return;
      }
      createBtn.disabled = true;
      try {
        const { person } = await FT.Trees.startNewTree(treeName.value, "", {
          first_name: first,
          middle_name: fields.middle.value.trim(),
          last_name: last,
          maiden_name: maiden,
          nickname: nick,
          gender: fields.gender.value,
          birth_date: fields.birth.value.trim(),
          death_date: fields.death.value.trim(),
          living: fields.living.value === "true",
          birth_place: fields.birthPlace.value.trim(),
          occupation: fields.occupation.value.trim(),
          notes: fields.notes.value.trim()
        });
        H.toast("Tree started with " + M.fullName(person) + ".", "success");
        // Re-render the workspace focused on the new first person.
        H.go(person ? "#/tree/" + person.id : "#/tree");
      } catch (e) {
        createBtn.disabled = false;
        H.toast(e.message || "Could not create the tree.", "error");
      }
    });

    const card = H.el("div", { class: "ft-card ft-empty ft-empty-tree" }, [
      H.el("p", { class: "ft-eyebrow" }, "New tree"),
      H.el("h1", { class: "ft-h1" }, "Start your family tree"),
      H.el("p", { class: "ft-muted" },
        "Name your tree and add its first person. You can keep building from there \u2014 or import a GEDCOM / JSON file from Import / Export."),
      H.el("div", { class: "ft-form-grid compact ft-empty-form" }, [
        field("Tree name", treeName, true),
        field("First name", input("first", { placeholder: "Given name" })),
        field("Last name", input("last")),
        field("Middle name", input("middle")),
        field("Maiden name", input("maiden")),
        field("Nickname", input("nick")),
        field("Gender", genderSel),
        field("Birth date", input("birth", { placeholder: "YYYY-MM-DD or YYYY" })),
        field("Death date", input("death", { placeholder: "YYYY-MM-DD or YYYY" })),
        field("Status", livingSel),
        field("Birthplace", input("birthPlace"), true),
        field("Occupation", input("occupation"), true),
        field("Notes", notes, true)
      ]),
      H.el("div", { class: "ft-form-actions" }, [
        createBtn,
        H.el("a", { class: "ft-btn ghost", href: "#/io" }, "Import instead")
      ])
    ]);
    main.appendChild(card);
  }

  FT.UI.TreeView = { render };
})(window.FT);
