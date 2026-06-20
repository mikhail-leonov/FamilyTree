/* ui/dashboard.js — statistics, recent edits, quick links.
 * v2: counts come from index.count() and one bounded cursor pass instead of
 * loading every person/marriage/event array into memory (performance spec). */
window.FT = window.FT || {};
FT.UI = FT.UI || {};

(function (FT) {
  "use strict";
  const H = FT.H, DB = FT.DB, M = FT.Models;
  const t = (k, v) => FT.t(k, v);

  async function render(main) {
    const treeId = FT.State.activeTreeId;
    const tree = await DB.get("trees", treeId);
    const only = IDBKeyRange.only(treeId);

    const [peopleCount, marriageCount, eventCount, livingCount] = await Promise.all([
      DB.countByIndex("persons", "tree_id", only),
      DB.countByIndex("marriages", "tree_id", only),
      DB.countByIndex("events", "tree_id", only),
      DB.tx("persons", "readonly", async (s) => {
        // living==1 within the tree: cheap cursor count on the tree index
        let n = 0;
        await new Promise((res, rej) => {
          const req = s.persons.index("tree_id").openCursor(only);
          req.onsuccess = (e) => {
            const c = e.target.result;
            if (!c) return res();
            if (c.value.living) n++;
            c.continue();
          };
          req.onerror = (e) => rej(e.target.error);
        });
        return n;
      })
    ]);

    // surnames + earliest birth in one pass over the tree index
    const surnames = new Set();
    let earliest = "";
    await DB.cursor("persons", "tree_id", only, "next", (p) => {
      if (p.last_name_lc) surnames.add(p.last_name_lc);
      if (p.birth_date && (!earliest || p.birth_date < earliest)) earliest = p.birth_date;
      return true;
    });

    // recent edits via composite [tree_id, updated] index, newest first
    const recent = await DB.page("persons", "tree_updated",
      IDBKeyRange.bound([treeId, ""], [treeId, "\uffff"]), "prev", 0, 8);

    const deceased = peopleCount - livingCount;

    main.appendChild(H.el("div", { class: "ft-page-head" }, [
      H.el("div", {}, [
        H.el("p", { class: "ft-eyebrow" }, t("dash.overview")),
        H.el("h1", { class: "ft-h1" }, tree ? tree.name : t("dash.title"))
      ]),
      H.el("div", { class: "ft-page-actions" }, [
        H.el("a", { class: "ft-btn ghost", href: "#/tree" }, t("common.viewTree")),
        H.el("a", { class: "ft-btn", href: "#/person-new" }, t("common.addPerson"))
      ])
    ]));

    if (peopleCount === 0) {
      main.appendChild(emptyStateCard(tree));
    }

    const stat = (label, value, sub) =>
      H.el("div", { class: "ft-stat" }, [
        H.el("div", { class: "ft-stat-val" }, String(value)),
        H.el("div", { class: "ft-stat-label" }, label),
        sub ? H.el("div", { class: "ft-stat-sub" }, sub) : null
      ]);

    main.appendChild(H.el("div", { class: "ft-stats" }, [
      stat(t("stat.people"), peopleCount),
      stat(t("stat.living"), livingCount, t("stat.deceased", { n: deceased })),
      stat(t("stat.marriages"), marriageCount),
      stat(t("stat.events"), eventCount),
      stat(t("stat.surnames"), surnames.size),
      stat(t("stat.earliestBirth"), earliest ? earliest.slice(0, 4) : "\u2014")
    ]));

    const list = H.el("div", { class: "ft-card" }, [
      H.el("h2", { class: "ft-h2" }, t("dash.recentlyEdited"))
    ]);
    if (!recent.length) {
      list.appendChild(H.el("p", { class: "ft-muted" }, t("dash.noPeople")));
    } else {
      const ul = H.el("ul", { class: "ft-recent" });
      recent.forEach((p) => {
        ul.appendChild(H.el("li", {}, [
          H.el("a", { href: "#/person/" + p.id, class: "ft-recent-name" }, M.fullName(p)),
          H.el("span", { class: "ft-recent-meta" }, [
            M.lifeSpan(p) ? M.lifeSpan(p) + " \u00b7 " : "",
            p.occupation || "\u2014"
          ].join(""))
        ]));
      });
      list.appendChild(ul);
    }
    main.appendChild(list);

    main.appendChild(H.el("div", { class: "ft-grid-2" }, [
      quickCard(t("quick.exploreTitle"), t("quick.exploreBody"), "#/tree", t("common.openViewer")),
      quickCard(t("quick.ioTitle"), t("quick.ioBody"), "#/io", t("common.manageData"))
    ]));
  }

  function emptyStateCard(tree) {
    return H.el("div", { class: "ft-card ft-empty" }, [
      H.el("h2", { class: "ft-h2" }, t("empty.title")),
      H.el("p", { class: "ft-muted" }, t("empty.body")),
      H.el("div", { class: "ft-empty-actions" }, [
        H.el("a", { class: "ft-btn", href: "#/tree" }, t("empty.start")),
        H.el("a", { class: "ft-btn ghost", href: "#/io" }, t("common.importData"))
      ])
    ]);
  }

  function quickCard(title, body, href, cta) {
    return H.el("div", { class: "ft-card ft-quick" }, [
      H.el("h2", { class: "ft-h2" }, title),
      H.el("p", { class: "ft-muted" }, body),
      H.el("a", { class: "ft-btn ghost", href }, cta)
    ]);
  }

  FT.UI.Dashboard = { render };
})(window.FT);