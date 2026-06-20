/* ============================================================================
 * i18n.js — lightweight localization engine.
 * Loads FIRST (before the language packs in js/lng/ and before any UI), so
 * FT.I18n.register() is available when each language file runs, and FT.t() is
 * available to every UI module at render time.
 *
 * A language pack (js/lng/en.js, js/lng/ru.js, …) registers itself with:
 *     FT.I18n.register("ru", { name:"Russian", nativeName:"Русский",
 *                              dir:"ltr", strings:{ "nav.tree":"Дерево", … } });
 * Dropping a new js/lng/<code>.js file (and a <script> tag for it) is all it
 * takes to add a language — it will appear in the switcher automatically.
 * ========================================================================== */
window.FT = window.FT || {};

(function (FT) {
  "use strict";

  const STORE_KEY = "ft_lang";
  const languages = {};        // code -> { code, name, nativeName, dir, strings }
  let current = null;          // active language code
  const listeners = [];        // called (code) whenever the language changes

  function register(code, def) {
    def = def || {};
    languages[code] = {
      code,
      name: def.name || code,
      nativeName: def.nativeName || def.name || code,
      dir: def.dir || "ltr",
      strings: def.strings || {}
    };
    if (!current) current = code;   // first pack registered becomes a provisional default
    return languages[code];
  }

  function list() { return Object.keys(languages).map((c) => languages[c]); }
  function has(code) { return !!languages[code]; }
  function lang() { return current; }

  /* Pick the initial language: saved choice → browser language → English → any. */
  function resolveInitial() {
    let saved = null;
    try { saved = localStorage.getItem(STORE_KEY); } catch (e) {}
    if (saved && languages[saved]) return saved;
    const nav = ((navigator && navigator.language) || "en").slice(0, 2).toLowerCase();
    if (languages[nav]) return nav;
    if (languages.en) return "en";
    return Object.keys(languages)[0] || "en";
  }

  function applyDoc() {
    const def = languages[current];
    if (!def) return;
    try {
      document.documentElement.lang = current;
      document.documentElement.dir = def.dir || "ltr";
    } catch (e) {}
  }

  function init() {
    current = resolveInitial();
    applyDoc();
  }

  function setLang(code, opts) {
    if (!languages[code]) return;
    const changed = code !== current;
    current = code;
    try { localStorage.setItem(STORE_KEY, code); } catch (e) {}
    applyDoc();
    if (changed && (!opts || opts.notify !== false))
      listeners.forEach((cb) => { try { cb(code); } catch (e) {} });
  }

  function onChange(cb) { if (typeof cb === "function") listeners.push(cb); }

  /* Translate a key for the active language, falling back to English, then to
   * the key itself. Supports {placeholder} interpolation from `vars`. */
  function t(key, vars) {
    const cur = languages[current];
    let s = cur && cur.strings[key];
    if (s == null && languages.en) s = languages.en.strings[key];
    if (s == null) s = key;
    if (vars) s = String(s).replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? vars[k] : m));
    return s;
  }

  /* Localize a static DOM subtree in place using data attributes:
   *   data-i18n="key"        -> textContent
   *   data-i18n-ph="key"     -> placeholder
   *   data-i18n-aria="key"   -> aria-label
   *   data-i18n-title="key"  -> title
   * Useful for the fixed shell (header/nav). Dynamic views just call FT.t(). */
  function localize(root) {
    root = root || document;
    root.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = t(el.getAttribute("data-i18n")); });
    root.querySelectorAll("[data-i18n-ph]").forEach((el) => { el.setAttribute("placeholder", t(el.getAttribute("data-i18n-ph"))); });
    root.querySelectorAll("[data-i18n-aria]").forEach((el) => { el.setAttribute("aria-label", t(el.getAttribute("data-i18n-aria"))); });
    root.querySelectorAll("[data-i18n-title]").forEach((el) => { el.setAttribute("title", t(el.getAttribute("data-i18n-title"))); });
  }

  FT.I18n = { register, list, has, lang, setLang, onChange, init, t, localize };
  FT.t = t;   // convenient shorthand used across the UI
})(window.FT);
