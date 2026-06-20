/* ui/people.js — paginated, sortable, searchable people list. 
 * v2: pages are fetched with cursor.advance() over composite
 * [tree_id, sortField] indexes — previously every page re-scanned the whole
 * tree index from record zero (O(n) per page). */
window.FT = window.FT || {};
FT.UI = FT.UI || {};

(function (FT) {
  "use strict";
  const H = FT.H, DB = FT.DB, M = FT.Models;
  const t = (k, v) => FT.t(k, v);

  const PAGE_SIZE = 25;
  const SORTS = [
    { key: "tree_last", labelKey: "sort.lastName" },
    { key: "tree_first", labelKey: "sort.firstName" },
    { key: "tree_birth", labelKey: "sort.birthDate" }
  ];

  async function render(main, query) {
    const treeId = FT.State.activeTreeId;
    const state = {
      page: Math.max(0, parseInt(query.page || "0", 10) || 0),
      sort: SORTS.some((s) => s.key === query.sort) ? query.sort : "tree_last",
      q: query.q || "",
      includeNotes: query.notes === "1"
    };

    main.appendChild(H.el("div", { class: "ft-page-head" }, [
      H.el("div", {}, [
        H.el("p", { class: "ft-eyebrow" }, t("people.records")),
        H.el("h1", { class: "ft-h1" }, t("people.title"))
      ]),
      H.el("div", { class: "ft-page-actions" }, [
        H.el("a", { class: "ft-btn", href: "#/person-new" }, t("common.addPerson"))
      ])
    ]));

    /* toolbar: search + sort + notes toggle */
    const searchInput = H.el("input", {
      class: "ft-input", type: "search", value: state.q,
      placeholder: t("people.searchPlaceholder"),
      "aria-label": t("people.searchPlaceholder")
    });
    const notesCheck = H.el("input", { type: "checkbox", id: "ppl-notes" });
    notesCheck.checked = state.includeNotes;
    const sortSel = H.el("select", { class: "ft-select", "aria-label": t("sort.lastName") },
      SORTS.map((s) => {
        const o = H.el("option", { value: s.key }, t(s.labelKey));
        if (s.key === state.sort) o.setAttribute("selected", "selected");
        return o;
      }));

    function nav() {
      const params = new URLSearchParams();
      if (state.q) params.set("q", state.q);
      if (state.includeNotes) params.set("notes", "1");
      if (state.sort !== "tree_last") params.set("sort", state.sort);
      if (state.page) params.set("page", String(state.page));
      H.go("#/people" + (params.toString() ? "?" + params.toString() : ""));
    }

    let debounce;
    searchInput.addEventListener("input", () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => { state.q = searchInput.value.trim(); state.page = 0; nav(); }, 280);
    });
    notesCheck.addEventListener("change", () => { state.includeNotes = notesCheck.checked; state.page = 0; nav(); });
    sortSel.addEventListener("change", () => { state.sort = sortSel.value; state.page = 0; nav(); });

    main.appendChild(H.el("div", { class: "ft-toolbar" }, [
      searchInput,
      sortSel,
      H.el("label", { class: "ft-check", for: "ppl-notes" }, [notesCheck, " " + t("people.includeNotes")])
    ]));

    const listWrap = H.el("div", { class: "ft-card ft-table-wrap" });
    main.appendChild(listWrap);
    listWrap.appendChild(H.el("p", { class: "ft-loading" }, t("common.loading")));

    let rows, total, searchMode = !!state.q;
    if (searchMode) {
      // ✅ FIXED: Get full results first to calculate correct total
      const fullResults = await FT.Search.search(state.q, { treeId, includeNotes: state.includeNotes, limit: 200 });
      total = fullResults.length;
      rows = fullResults.slice(state.page * PAGE_SIZE, (state.page + 1) * PAGE_SIZE);
    } else {
      total = await DB.countByIndex("persons", "tree_id", IDBKeyRange.only(treeId));
      const range = IDBKeyRange.bound([treeId, ""], [treeId, "\uffff"]);
      rows = await DB.page("persons", state.sort, range, "next", state.page * PAGE_SIZE, PAGE_SIZE);
    }

    H.clear(listWrap);
    if (!rows.length) {
      listWrap.appendChild(H.el("div", { class: "ft-pad" }, [
        H.el("h2", { class: "ft-h2" }, searchMode ? t("people.noMatches") : t("people.noPeople")),
        H.el("p", { class: "ft-muted" }, searchMode
          ? t("people.noMatchesBody")
          : t("people.noPeopleBody"))
      ]));
    } else {
      const table = H.el("table", { class: "ft-table" }, [
        H.el("thead", {}, H.el("tr", {}, [
          H.el("th", {}, t("table.name")), H.el("th", {}, t("table.lifespan")),
          H.el("th", {}, t("table.birthplace")), H.el("th", {}, t("table.occupation")),
          H.el("th", { class: "ft-th-actions" }, "")
        ]))
      ]);
      const tbody = H.el("tbody");
      rows.forEach((p) => {
        const tr = H.el("tr", {}, [
          H.el("td", {}, [
            H.el("a", { href: "#/person/" + p.id, class: "ft-link-strong" }, M.fullName(p)),
            p.nickname ? H.el("span", { class: "ft-nick" }, " \u201c" + p.nickname + "\u201d") : null,
            p._matched ? H.el("span", { class: "ft-match" }, " \u00b7 matched: " + p._matched.join(", ")) : null
          ]),
          H.el("td", {}, M.lifeSpan(p) || (p.living ? t("people.living") : "")),
          H.el("td", {}, p.birth_place || "\u2014"),
          H.el("td", {}, p.occupation || "\u2014"),
          H.el("td", { class: "ft-row-actions" }, [
            H.el("a", { class: "ft-chip", href: "#/tree/" + p.id, title: t("common.viewTree") }, t("common.tree")),
            H.el("a", { class: "ft-chip", href: "#/story/" + p.id, title: t("story.eyebrow") }, t("common.story"))
          ])
        ]);
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      listWrap.appendChild(table);
    }

    /* pager */
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    if (pages > 1) {
      const pager = H.el("div", { class: "ft-pager", role: "navigation", "aria-label": "Pagination" });
      const prev = H.el("button", { class: "ft-btn ghost sm" }, t("common.prev"));
      const next = H.el("button", { class: "ft-btn ghost sm" }, t("common.next"));
      if (state.page <= 0) prev.setAttribute("disabled", "disabled");
      if (state.page >= pages - 1) next.setAttribute("disabled", "disabled");
      prev.addEventListener("click", () => { state.page--; nav(); });
      next.addEventListener("click", () => { state.page++; nav(); });
      pager.appendChild(prev);
      pager.appendChild(H.el("span", { class: "ft-muted" },
        " " + t("people.pageInfo", { page: state.page + 1, pages: pages, total: total,
          unit: searchMode ? t("people.unitMatches") : t("people.unitPeople") }) + " "));
      pager.appendChild(next);
      main.appendChild(pager);
    }
  }

  FT.UI.People = { render };
})(window.FT);