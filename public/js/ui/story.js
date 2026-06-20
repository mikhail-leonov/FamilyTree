/* ui/story.js — narrative, chronological timeline, printable life story */
window.FT = window.FT || {};
FT.UI = FT.UI || {};

(function (FT) {
  "use strict";
  const H = FT.H, M = FT.Models, Story = FT.Story, Data = FT.Data;
  const t = (k, v) => FT.t(k, v);

  async function render(main, params) {
    const p = await Data.Persons.get(params.id);
    if (!p) { main.appendChild(H.el("p", { class: "ft-muted ft-pad" }, "Person not found.")); return; }

    let mode = "narrative";

    main.appendChild(H.el("div", { class: "ft-page-head" }, [
      H.el("div", {}, [
        H.el("p", { class: "ft-eyebrow" }, t("story.eyebrow")),
        H.el("h1", { class: "ft-h1" }, M.fullName(p))
      ]),
      H.el("div", { class: "ft-page-actions" }, [
        H.el("a", { class: "ft-btn ghost", href: "#/tree/" + p.id }, t("common.tree")),
        H.el("a", { class: "ft-btn ghost", href: "#/person/" + p.id }, t("common.edit")),
        H.el("button", { class: "ft-btn", onclick: () => window.print() }, t("common.print"))
      ])
    ]));

    const tabs = H.el("div", { class: "ft-tabs" }, [
      tab(t("tab.narrative"), "narrative"),
      tab(t("tab.timeline"), "timeline")
    ]);
    main.appendChild(tabs);

    const body = H.el("div", { class: "ft-card ft-story" });
    main.appendChild(body);

    function tab(label, key) {
      const b = H.el("button", { class: "ft-tab" + (key === mode ? " active" : "") }, label);
      b.addEventListener("click", () => { mode = key; updateTabs(); draw(); });
      b._key = key;
      return b;
    }
    function updateTabs() {
      tabs.querySelectorAll(".ft-tab").forEach((el) => el.classList.toggle("active", el._key === mode));
    }

    async function draw() {
      H.clear(body);
      // header block with portrait

      let portrait = null;
      if (p.profile_photo_id) {
        const m = await Data.Media.get(p.profile_photo_id);
        // ✅ FIXED: Fallback to m.thumbnail || m.data
        if (m && (m.data || m.thumbnail)) portrait = H.el("img", { class: "ft-portrait", src: m.data || m.thumbnail, alt: M.fullName(p) });
      }

      body.appendChild(H.el("div", { class: "ft-story-head" }, [
        portrait,
        H.el("div", {}, [
          H.el("h2", { class: "ft-story-name" }, M.fullName(p)),
          H.el("p", { class: "ft-muted" }, [M.lifeSpan(p), p.occupation, p.residence].filter(Boolean).join(" \u00b7 "))
        ])
      ]));

      if (mode === "narrative") {
        const text = await Story.narrative(p.id);
        text.split("\n").filter(Boolean).forEach((para) =>
          body.appendChild(H.el("p", { class: "ft-prose" }, para)));
        if (!text) body.appendChild(H.el("p", { class: "ft-muted" }, t("story.notEnough")));
      } else {
        const items = await Story.timeline(p.id);
        if (!items.length) { body.appendChild(H.el("p", { class: "ft-muted" }, t("story.noEvents"))); return; }
        const tl = H.el("ol", { class: "ft-timeline" });
        items.forEach((it) => {
          const rel = it.relation || "self";
          const textNodes = [H.el("span", { class: "ft-timeline-text" }, it.text)];
          if (rel !== "self") textNodes.unshift(H.el("span", { class: "ft-timeline-rel" }, rel === "parent" ? t("rel.parents") : t("rel.children")));
          tl.appendChild(H.el("li", { class: "ft-timeline-item " + it.type + " rel-" + rel }, [
            H.el("span", { class: "ft-timeline-year" }, it.date ? it.date.slice(0, 4) : "\u2014"),
            H.el("span", { class: "ft-timeline-dot" }),
            H.el("div", { class: "ft-timeline-body" }, [
              H.el("div", { class: "ft-timeline-date" }, it.date ? Story.nice(it.date) : "Undated"),
              H.el("div", { class: "ft-timeline-textwrap" }, textNodes)
            ])
          ]));
        });
        body.appendChild(tl);
      }
    }

    draw();
  }

  FT.UI.StoryView = { render };
})(window.FT);