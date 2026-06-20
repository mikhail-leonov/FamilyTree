/* ui/io.js — Import / Export: GEDCOM, JSON, new tree, clear data  */
window.FT = window.FT || {};
FT.UI = FT.UI || {};

(function (FT) {
  "use strict";
  const H = FT.H, DB = FT.DB, M = FT.Models;
  const t = (k, v) => FT.t(k, v);

  async function render(main) {
    main.appendChild(H.el("div", { class: "ft-page-head" }, [
      H.el("div", {}, [
        H.el("p", { class: "ft-eyebrow" }, t("io.eyebrow")),
        H.el("h1", { class: "ft-h1" }, t("io.title"))
      ])
    ]));

    main.appendChild(H.el("div", { class: "ft-grid-2" }, [
      gedcomImportCard(),
      gedcomExportCard(),
      jsonImportCard(),
      jsonExportCard(),
      dangerCard()
    ]));
  }

  function card(title, desc, body) {
    return H.el("div", { class: "ft-card" }, [
      H.el("h2", { class: "ft-h2" }, title),
      desc ? H.el("p", { class: "ft-muted" }, desc) : null,
      body
    ]);
  }

  /* ---- GEDCOM import ---- */
  function gedcomImportCard() {
    const status = H.el("div", { class: "ft-io-status" });
    const file = H.el("input", { type: "file", accept: ".ged,.gedcom,text/plain", class: "ft-file" });
    file.addEventListener("change", async () => {
      const f = file.files[0]; if (!f) return;
      status.textContent = "Parsing\u2026";
      try {
        const text = await f.text();
        const { payload } = FT.GedcomParser.parse(text, FT.State.activeTreeId);
        const { stats, conflicts } = await FT.Data.Batch.merge(payload, FT.State.activeTreeId);   // ✅ conflict-aware merge
        status.innerHTML = "";
        status.appendChild(H.el("p", { class: "ft-ok" },
          "Imported " + stats.persons + " new people" +
          (stats.merged ? " (" + stats.merged + " matched & updated)" : "") +
          ", " + stats.marriages + " marriages, " + stats.relationships +
          " parent-child links, " + stats.events + " events."));
        renderConflicts(status, conflicts, "gedcom");
        H.toast("GEDCOM imported." + (conflicts && conflicts.length ? " " + conflicts.length + " conflict(s) logged." : ""),
          conflicts && conflicts.length ? "info" : "success");
      } catch (e) { status.textContent = "Import failed: " + e.message; H.toast(e.message, "error"); }
    });
    return card(t("io.gedImportTitle"), t("io.gedImportDesc"),
      H.el("div", {}, [H.el("label", { class: "ft-upload" }, [t("io.gedChoose"), file]), status]));
  }

  /* ---- GEDCOM export ---- */
  function gedcomExportCard() {
    const btn = H.el("button", { class: "ft-btn", onclick: async () => {
      const text = await FT.GedcomExporter.toGEDCOM(FT.State.activeTreeId);
      const tree = await DB.get("trees", FT.State.activeTreeId);
      H.download(safe(tree && tree.name) + ".ged", text, "text/plain");
      H.toast("GEDCOM exported.", "success");
    } }, t("io.gedExportBtn"));
    return card(t("io.gedExportTitle"), t("io.gedExportDesc"), btn);
  }

  /* ---- JSON export ---- */
  function jsonExportCard() {
    const btn = H.el("button", { class: "ft-btn", onclick: async () => {
      const text = await FT.GedcomExporter.toJSON(FT.State.activeTreeId);
      const tree = await DB.get("trees", FT.State.activeTreeId);
      H.download(safe(tree && tree.name) + ".json", text, "application/json");
      H.toast("JSON exported.", "success");
    } }, t("io.jsonExportBtn"));
    return card(t("io.jsonExportTitle"), t("io.jsonExportDesc"), btn);
  }

  /* ---- JSON import ---- */
  function jsonImportCard() {
    const status = H.el("div", { class: "ft-io-status" });
    const file = H.el("input", { type: "file", accept: ".json,application/json", class: "ft-file" });
    file.addEventListener("change", async () => {
      const f = file.files[0]; if (!f) return;
      status.textContent = "Importing\u2026";
      try {
        const text = await f.text();
        const result = await FT.GedcomExporter.fromJSON(text);
        await FT.Trees.loadTrees();
        status.innerHTML = "";
        status.appendChild(H.el("p", { class: "ft-ok" },
          "Import successful. " + result.stats.persons + " new people" +
          (result.stats.merged ? " (" + result.stats.merged + " matched & updated)" : "") +
          ", " + result.stats.relationships + " links."));
        renderConflicts(status, result.conflicts, "json");
        H.toast("JSON imported." + (result.conflicts && result.conflicts.length ? " " + result.conflicts.length + " conflict(s) logged." : ""),
          result.conflicts && result.conflicts.length ? "info" : "success");
      } catch (e) { 
        console.error("Import error:", e);
        status.textContent = "Import failed: " + e.message; 
        H.toast(e.message, "error"); 
      }
    });
    return card(t("io.jsonImportTitle"), t("io.jsonImportDesc"),
      H.el("div", {}, [H.el("label", { class: "ft-upload" }, [t("io.jsonChoose"), file]), status]));
  }



  /* ---- danger zone ---- */
  function dangerCard() {
    const btn = H.el("button", { class: "ft-btn danger", onclick: async () => {
      if (!H.confirm("Erase ALL trees and data from this browser? This cannot be undone.")) return;
      await DB.clearAll();
      H.toast("All data cleared. Reloading\u2026", "success");
      setTimeout(() => location.reload(), 800);
    } }, t("io.dangerBtn"));
    return card(t("io.dangerTitle"), t("io.dangerDesc"), btn);
  }

  /* ---- conflict log rendering (shared by GEDCOM + JSON import) ---- */
  function renderConflicts(status, conflicts, source) {
    if (!conflicts || !conflicts.length) return;
    const FIELD_LABELS = {
      first_name: "First name", middle_name: "Middle name", last_name: "Last name",
      maiden_name: "Maiden name", nickname: "Nickname", birth_date: "Birth date",
      death_date: "Death date", birth_place: "Birth place", death_place: "Death place",
      residence: "Residence", biography: "Biography", notes: "Notes",
      occupation: "Occupation", education: "Education", gender: "Gender"
    };
    const label = (f) => FIELD_LABELS[f] || f;

    const box = H.el("div", { class: "ft-conflict-log" });
    box.appendChild(H.el("p", { class: "ft-conflict-head" },
      conflicts.length + " conflict" + (conflicts.length === 1 ? "" : "s") +
      " kept the existing values (incoming values were not applied):"));

    const ul = H.el("ul", { class: "ft-conflict-list" });
    conflicts.slice(0, 12).forEach((c) => {
      ul.appendChild(H.el("li", {}, [
        H.el("strong", {}, c.person_name + " \u2014 " + label(c.field) + ": "),
        H.el("span", { class: "ft-conflict-kept" }, "kept \u201C" + c.existing + "\u201D"),
        H.el("span", { class: "ft-muted" }, " \u00b7 ignored \u201C" + c.incoming + "\u201D")
      ]));
    });
    box.appendChild(ul);
    if (conflicts.length > 12)
      box.appendChild(H.el("p", { class: "ft-muted" }, "\u2026and " + (conflicts.length - 12) + " more. Download the full log below."));

    const dl = H.el("button", { class: "ft-btn ghost sm", onclick: () => {
      const header = "person\tfield\texisting (kept)\tincoming (ignored)";
      const rows = conflicts.map((c) =>
        [c.person_name, label(c.field), c.existing, c.incoming]
          .map((v) => String(v).replace(/[\t\r\n]+/g, " ")).join("\t"));
      H.download("import-conflicts-" + (source || "import") + ".tsv",
        header + "\n" + rows.join("\n"), "text/tab-separated-values");
    } }, "Download conflict log");
    box.appendChild(dl);
    status.appendChild(box);
  }

  function safe(s) { return (s || "family-tree").replace(/[^a-z0-9_-]+/gi, "_"); }

  FT.UI.IO = { render };
})(window.FT);