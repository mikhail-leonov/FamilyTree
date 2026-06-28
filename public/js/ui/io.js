/* ui/io.js — Import / Export: GEDCOM, JSON, new tree, clear data */
window.FT = window.FT || {};
FT.UI = FT.UI || {};

(function (FT) {
  "use strict";
  const H = FT.H, DB = FT.DB, M = FT.Models;
  const t = (k, v) => FT.t(k, v);

  /* Small inline-SVG icons (trusted static markup) for each card header. */
  const ICONS = {
    gedImport: "<svg viewBox='0 0 24 24' width='20' height='20' fill='none' stroke='currentColor' stroke-width='1.7' stroke-linecap='round' stroke-linejoin='round'><path d='M12 3v12'/><path d='m8 11 4 4 4-4'/><path d='M5 21h14'/></svg>",
    gedExport: "<svg viewBox='0 0 24 24' width='20' height='20' fill='none' stroke='currentColor' stroke-width='1.7' stroke-linecap='round' stroke-linejoin='round'><path d='M12 15V3'/><path d='m8 7 4-4 4 4'/><path d='M5 21h14'/></svg>",
    jsonImport: "<svg viewBox='0 0 24 24' width='20' height='20' fill='none' stroke='currentColor' stroke-width='1.7' stroke-linecap='round' stroke-linejoin='round'><path d='M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z'/><path d='M14 3v5h6'/><path d='m9 15 2 2 3-3'/></svg>",
    jsonExport: "<svg viewBox='0 0 24 24' width='20' height='20' fill='none' stroke='currentColor' stroke-width='1.7' stroke-linecap='round' stroke-linejoin='round'><path d='M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z'/><path d='M14 3v5h6'/><path d='M12 18v-6'/><path d='m9 15 3 3 3-3'/></svg>",
    danger: "<svg viewBox='0 0 24 24' width='20' height='20' fill='none' stroke='currentColor' stroke-width='1.7' stroke-linecap='round' stroke-linejoin='round'><path d='M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z'/><path d='M12 9v4'/><path d='M12 17h.01'/></svg>"
  };

  async function render(main) {
    main.appendChild(H.el("div", { class: "ft-page-head" }, [
      H.el("div", {}, [
        H.el("p", { class: "ft-eyebrow" }, t("io.eyebrow")),
        H.el("h1", { class: "ft-h1" }, t("io.title"))
      ])
    ]));

    main.appendChild(section(t("io.secImport") , t("io.secImportDesc"), [
      gedcomImportCard(),
      jsonImportCard()
    ]));

    main.appendChild(section(t("io.secExport"), t("io.secExportDesc"), [
      gedcomExportCard(),
      jsonExportCard()
    ]));

    main.appendChild(dangerCard());
  }

  /* A titled group of cards, mirroring the visual rhythm of the other pages. */
  function section(title, desc, cards) {
    return H.el("section", { class: "ft-io-section" }, [
      H.el("div", { class: "ft-io-section-head" }, [
        H.el("h2", { class: "ft-h2" }, title),
        desc ? H.el("p", { class: "ft-muted" }, desc) : null
      ]),
      H.el("div", { class: "ft-grid-2" }, cards)
    ]);
  }

  function card(title, desc, body, opts) {
    opts = opts || {};
    const head = H.el("div", { class: "ft-io-card-head" }, [
      opts.icon ? H.el("span", { class: "ft-io-icon" + (opts.accent ? " " + opts.accent : ""), html: opts.icon }) : null,
      H.el("div", {}, [
        H.el("h3", { class: "ft-io-card-title" }, title),
        desc ? H.el("p", { class: "ft-muted ft-io-card-desc" }, desc) : null
      ])
    ]);
    return H.el("div", { class: "ft-card ft-io-card" + (opts.accent ? " " + opts.accent : "") }, [
      head,
      H.el("div", { class: "ft-io-card-body" }, [body])
    ]);
  }

  /* A file picker that matches the page's other buttons: the trigger is a
   * styled <label> (ghost button) and the native <input type=file> is visually
   * hidden but still activated by clicking the label. */
  function filePicker(labelText, attrs, onFile) {
    const input = H.el("input", Object.assign(
      { type: "file", class: "ft-file ft-visually-hidden" }, attrs || {}));
    input.addEventListener("change", () => {
      const f = input.files && input.files[0];
      if (f) onFile(f);
    });
    return H.el("label", { class: "ft-btn ghost ft-upload-btn" }, [labelText, input]);
  }

  /* ---- GEDCOM import ---- */
  function gedcomImportCard() {
    const status = H.el("div", { class: "ft-io-status" });
    const picker = filePicker(t("io.gedChoose"),
      { accept: ".ged,.gedcom,text/plain" }, async (f) => {
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
      H.el("div", {}, [picker, status]), { icon: ICONS.gedImport });
  }

  /* ---- GEDCOM export ---- */
  function gedcomExportCard() {
    const btn = H.el("button", { class: "ft-btn", onclick: async () => {
      const text = await FT.GedcomExporter.toGEDCOM(FT.State.activeTreeId);
      const tree = await DB.get("trees", FT.State.activeTreeId);
      H.download(safe(tree && tree.name) + ".ged", text, "text/plain");
      H.toast("GEDCOM exported.", "success");
    } }, t("io.gedExportBtn"));
    return card(t("io.gedExportTitle"), t("io.gedExportDesc"), btn, { icon: ICONS.gedExport });
  }

  /* ---- JSON export ---- */
  function jsonExportCard() {
    const btn = H.el("button", { class: "ft-btn", onclick: async () => {
      const text = await FT.GedcomExporter.toJSON(FT.State.activeTreeId);
      const tree = await DB.get("trees", FT.State.activeTreeId);
      H.download(safe(tree && tree.name) + ".json", text, "application/json");
      H.toast("JSON exported.", "success");
    } }, t("io.jsonExportBtn"));
    return card(t("io.jsonExportTitle"), t("io.jsonExportDesc"), btn, { icon: ICONS.jsonExport });
  }

  /* ---- JSON import ---- */
  function jsonImportCard() {
    const status = H.el("div", { class: "ft-io-status" });
    const picker = filePicker(t("io.jsonChoose"),
      { accept: ".json,application/json" }, async (f) => {
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
      H.el("div", {}, [picker, status]), { icon: ICONS.jsonImport });
  }



  /* ---- danger zone ---- */
  function dangerCard() {
    const btn = H.el("button", { class: "ft-btn danger", onclick: async () => {
      if (!H.confirm("Erase ALL trees and data from this browser? This cannot be undone.")) return;
      await DB.clearAll();
      H.toast("All data cleared. Reloading\u2026", "success");
      setTimeout(() => location.reload(), 800);
    } }, t("io.dangerBtn"));
    return card(t("io.dangerTitle"), t("io.dangerDesc"), btn, { icon: ICONS.danger, accent: "danger" });
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
