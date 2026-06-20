/* ============================================================================ 
 * app.js — application shell: global state, hash router, shared UI helpers,
 * and bootstrap (open DB, seed demo on first run, wire navigation).
 * Loads LAST.
 * ========================================================================== */
window.FT = window.FT || {};
(function (FT) {
  "use strict";
  // ✅ REMOVED: Duplicate FT.State & H definitions. core.js handles this.
  const H = FT.H;
 
  /* ----------------------------- router ----------------------------- */
  const routes = [];
  function route(pattern, handler) {
    const keys = [];
    const rx = new RegExp("^#" + pattern.replace(/:[^/]+/g, (m) => {
      keys.push(m.slice(1)); return "([^/]+)";
    }) + "$");
    routes.push({ rx, keys, handler });
  }
  function parseQuery(qs) {
    const out = {};
    (qs || "").split("&").forEach((pair) => {
      if (!pair) return;
      const i = pair.indexOf("=");
      const k = i >= 0 ? pair.slice(0, i) : pair;
      const v = i >= 0 ? pair.slice(i + 1) : "";
      
      const key = decodeURIComponent(k);
      let val = decodeURIComponent(v);
      
      // FIX: Securely sanitize and convert pagination parameter to an absolute integer 
      // to eliminate NaN downstream inside IndexedDB query offsets.
      if (key === "page") {
        const parsed = parseInt(val, 10);
        val = (!isNaN(parsed) && parsed > 0) ? parsed : 1;
      }
      
      out[key] = val;
    });
    return out;
  }
  async function dispatch() {
    const hash = window.location.hash || "#/dashboard";
    const qIndex = hash.indexOf("?");
    const path = qIndex >= 0 ? hash.slice(0, qIndex) : hash;
    const query = qIndex >= 0 ? parseQuery(hash.slice(qIndex + 1)) : {};
    const main = document.getElementById("ft-main");
    document.querySelectorAll(".ft-nav a").forEach((a) => {
      a.classList.toggle("active", path.startsWith(a.getAttribute("data-match") || a.getAttribute("href")));
    });
    for (const r of routes) {
      const m = path.match(r.rx);
      if (m) {
        // FIX: Ensure parameters and the sanitized query dictionary are unified 
        // and safely spread directly onto parameters passed down to the render engine.
        const params = { _query: query, ...query };
        r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
        H.clear(main);
        try { 
          await r.handler(main, params); 
          // Dynamically apply checkmark visual states if we just routed into the Tree view
          if (path.startsWith("#/tree")) {
            applySavedSettingsToUI();
          }
        }
        catch (err) { console.error(err); H.toast("Error: " + err.message, "error"); }
        main.scrollTop = 0;
        return;
      }
    }
    H.go("#/dashboard");
  }
  FT.Router = { route, dispatch };

  /* ----------------------- single-tree enforcement ----------------------- */
  /* Req 1: the app now holds exactly ONE family tree. On boot (and after any
   * import) every record is consolidated under a single canonical tree id, and
   * any extra tree records are removed. Person/relationship IDs are preserved —
   * only `tree_id` is normalised — so relationships keep working and no records
   * are duplicated. */
  async function mergeAllIntoSingleTree() {
    let trees = await FT.DB.getAll("trees");
    let canonical = null;
    const meta = await FT.DB.get("metadata", "active_tree");
    if (meta && meta.value) canonical = trees.find((t) => t.id === meta.value) || null;
    if (!canonical) canonical = trees[0] || null;
    if (!canonical) {
      canonical = FT.Models.tree({ name: "My Family" });
      await FT.DB.put("trees", canonical);
      trees = [canonical];
    }
    const cid = canonical.id;

    // Reassign any record that belongs to a different tree (only when needed).
    if (trees.length > 1) {
      const stores = ["persons", "relationships", "marriages", "events", "media"];
      await FT.DB.tx(stores, "readwrite", async (s) => {
        for (const name of stores) {
          const all = await FT.DB.reqP(s[name].getAll());
          for (const rec of all) {
            if (rec.tree_id !== cid) { rec.tree_id = cid; await FT.DB.reqP(s[name].put(rec)); }
          }
        }
      });
      for (const t of trees) if (t.id !== cid) await FT.DB.del("trees", t.id);
    }

    FT.State.trees = [canonical];
    FT.State.activeTreeId = cid;
    await FT.DB.put("metadata", { key: "active_tree", value: cid });
    return canonical;
  }

  // Back-compat names kept so existing callers (io.js) keep working.
  async function loadTrees() { return mergeAllIntoSingleTree(); }
  async function setActiveTree() { dispatch(); }          // no-op: only one tree
  function renderTreeSelect() {}                          // tree switcher removed

  /* Start a brand-new family tree AND its first person in one step. Only
   * permitted while the current tree has no people yet — otherwise this would
   * silently orphan existing records (use the Danger zone to erase first).
   * Creates a fresh tree row, makes it the active/canonical tree, consolidates
   * so exactly one tree remains, then creates the first person and focuses on
   * them. Returns { tree, person }. */
  async function startNewTree(name, description, personData) {
    const count = await FT.Data.Persons.countInTree(FT.State.activeTreeId);
    if (count > 0)
      throw new Error("You can only start a new tree while the current one is empty. Erase your data first.");
    const t = FT.Models.tree({
      name: (name || "").trim() || "My Family",
      description: (description || "").trim()
    });
    await FT.DB.put("trees", t);
    await FT.DB.put("metadata", { key: "active_tree", value: t.id });
    await mergeAllIntoSingleTree();   // canonicalises onto the new tree, removes the old empty one

    // Create the first person of the tree (a tree needs at least one named person).
    let person = null;
    const hasName = personData && (personData.first_name || personData.last_name ||
                                   personData.maiden_name || personData.nickname);
    if (hasName) {
      person = await FT.Data.Persons.save(
        Object.assign({}, personData, { tree_id: FT.State.activeTreeId }));
      await FT.DB.put("metadata", { key: "last_focus_person", value: person.id });
    }
    return { tree: FT.State.trees[0], person };
  }

  FT.Trees = { loadTrees, setActiveTree, renderTreeSelect, mergeAllIntoSingleTree, startNewTree };

  /**
   * Helper utility to reflect loaded configurations onto the DOM input elements directly.
   */
  function applySavedSettingsToUI() {
    const settings = FT.State.layoutSettings;
    if (!settings) return;
    
    Object.keys(settings).forEach((settingId) => {
      const element = document.getElementById(settingId);
      if (element && element.type === "checkbox") {
        element.checked = !!settings[settingId];
      }
    });
  }

  /* ----------------------------- bootstrap ----------------------------- */
  async function boot() {
    await FT.DB.open();
    await mergeAllIntoSingleTree();   // Req 1: collapse any/all trees into one

    // ✅ NEW: Load visual settings data out of IndexedDB on start
    try {
      const savedSettings = await FT.DB.get("metadata", "tree_layout_settings");
      FT.State.layoutSettings = savedSettings ? savedSettings.value : {
        "show-bio-only": false,
        "compact-cards": false,
        "hide-unrelated": false,
        "highlight-custom": true
      };
    } catch (err) {
      console.warn("Failed to load layout settings, using defaults.", err);
      FT.State.layoutSettings = {};
    }

    // ✅ MANDATE REQ: Seeding architecture dropped. System runs a pure initialization flow.
    const count = await FT.Data.Persons.countInTree(FT.State.activeTreeId);
    if (count === 0) {
      console.log("Cold start initialized: No records found. Standing by for dynamic user entry or GEDCOM import.");
    }

    route("/dashboard", FT.UI.Dashboard.render);
    route("/people", FT.UI.People.render);
    route("/person/:id", FT.UI.Editor.render);
    route("/person-new", FT.UI.Editor.renderNew);
    route("/tree", FT.UI.TreeView.render);
    route("/tree/:id", FT.UI.TreeView.render);
    route("/story/:id", FT.UI.StoryView.render);
    route("/io", FT.UI.IO.render);

    // Tree switcher removed (Req 1) — guard in case the element is absent.
    const treeSel = document.getElementById("ft-tree-select");
    if (treeSel) treeSel.addEventListener("change", (e) => setActiveTree(e.target.value));

    const qs = document.getElementById("ft-quick-search");
    if (qs) qs.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && qs.value.trim()) H.go("#/people?q=" + encodeURIComponent(qs.value.trim()));
    });

    /* ----------------------- localization ----------------------- */
    FT.I18n.init();                 // pick saved / browser / default language
    FT.I18n.localize(document);     // translate the static shell (nav, search, brand)

    const langSel = document.getElementById("ft-lang");
    if (langSel) {
      FT.I18n.list().forEach((l) => {
        const o = document.createElement("option");
        o.value = l.code; o.textContent = l.nativeName;
        langSel.appendChild(o);
      });
      langSel.value = FT.I18n.lang();
      langSel.addEventListener("change", () => FT.I18n.setLang(langSel.value));
    }
    FT.I18n.onChange(() => {
      FT.I18n.localize(document);                 // re-translate the static shell
      const sel = document.getElementById("ft-lang");
      if (sel) sel.value = FT.I18n.lang();
      dispatch();                                 // re-render the active view in the new language
    });

    window.addEventListener("hashchange", dispatch);
    dispatch();
  }

  document.addEventListener("DOMContentLoaded", boot);
})(window.FT); 