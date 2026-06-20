/* ============================================================================
 * core.js — shared application state and DOM/UI helpers.
 * Loads FIRST so every other module can rely on FT.State and FT.H being
 * defined at the moment their script is parsed.
 * ========================================================================== */
window.FT = window.FT || {};

(function (FT) {
  "use strict";

  FT.State = FT.State || { activeTreeId: null, trees: [] };

  const H = {
    el(tag, attrs, children) {
      const n = document.createElement(tag);
      if (attrs) for (const k in attrs) {
        if (k === "class") n.className = attrs[k];
        else if (k === "html") n.innerHTML = attrs[k];
        else if (k.startsWith("on") && typeof attrs[k] === "function")
          n.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] != null) n.setAttribute(k, attrs[k]);
      }
      if (children != null) {
        (Array.isArray(children) ? children : [children]).forEach((c) => {
          if (c == null) return;
          n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
        });
      }
      return n;
    },
    esc(s) {
      return (s == null ? "" : String(s)).replace(/[&<>"']/g, (c) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    },
    clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; },
    toast(msg, kind) {
      const wrap = document.getElementById("ft-toasts");
      if (!wrap) return;
      const t = H.el("div", { class: "ft-toast " + (kind || "info") }, msg);
      wrap.appendChild(t);
      requestAnimationFrame(() => t.classList.add("show"));
      setTimeout(() => { t.classList.remove("show"); setTimeout(() => t.remove(), 300); }, 3200);
    },
    confirm(msg) { return window.confirm(msg); },
    go(hash) { window.location.hash = hash; },
    download(filename, text, mime) {
      const blob = new Blob([text], { type: mime || "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = H.el("a", { href: url, download: filename });
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  };
  FT.H = H;
})(window.FT);
