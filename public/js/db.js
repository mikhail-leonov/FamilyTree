/* ============================================================================
 * db.js — IndexedDB open/upgrade + low-level helpers.
 *
 * This module was previously inconsistent with the rest of the application
 * (wrong tx() argument order, a missing reqP()/page() helper, a missing `media`
 * store, and index names/keyPaths that did not match the records actually
 * written by models.js or the queries issued by the services). That mismatch
 * surfaced as "Cannot read properties of undefined (reading 'index')" on boot.
 *
 * The schema below is derived from every index the codebase queries:
 *   - persons:        tree_id, the six search indexes (on the *_lc fields), and
 *                     the composite sort indexes used by the People/Dashboard
 *                     paginated lists.
 *   - relationships:  tree_id, parent_id, child_id, and the composite `edge`
 *                     ([parent_id, child_id]) used for duplicate detection.
 *   - marriages:      tree_id, spouse1_id, spouse2_id.
 *   - events:         tree_id, type, and a multiEntry `people` index.
 *   - media:          tree_id, person_id.
 *   - trees/metadata: single-tree bookkeeping.
 *   - deleted_items/history: present for spec completeness (soft-delete/undo).
 *
 * The version is bumped so onupgradeneeded re-runs and RECONCILES stores and
 * indexes for anyone whose database was created by the older, broken build:
 * stale indexes are dropped and the correct ones (re)created over existing
 * data. No records are deleted by the upgrade.
 * ========================================================================== */
window.FT = window.FT || {};

(function (FT) {
  "use strict";

  const DB_NAME = "FamilyTreeDB";
  const DB_VERSION = 6;

  // name -> keyPath ; multiEntry only where noted.
  const SCHEMA = {
    trees: {
      keyPath: "id",
      indexes: [{ name: "name", keyPath: "name" }]
    },
    persons: {
      keyPath: "id",
      indexes: [
        { name: "tree_id", keyPath: "tree_id" },
        // search indexes (keyed on the lowercased fields produced by models.js)
        { name: "last_name", keyPath: "last_name_lc" },
        { name: "first_name", keyPath: "first_name_lc" },
        { name: "maiden_name", keyPath: "maiden_name_lc" },
        { name: "nickname", keyPath: "nickname_lc" },
        { name: "occupation", keyPath: "occupation_lc" },
        { name: "birth_place", keyPath: "birth_place_lc" },
        // composite sort indexes for the paginated lists ([tree_id, field])
        { name: "tree_last", keyPath: ["tree_id", "last_name_lc"] },
        { name: "tree_first", keyPath: ["tree_id", "first_name_lc"] },
        { name: "tree_birth", keyPath: ["tree_id", "birth_date"] },
        { name: "tree_updated", keyPath: ["tree_id", "updated"] },
        { name: "email_lc", keyPath: "email_lc" },
        { name: "burial_place_lc", keyPath: "burial_place_lc" }
      ]
    },
    relationships: {
      keyPath: "id",
      indexes: [
        { name: "tree_id", keyPath: "tree_id" },
        { name: "parent_id", keyPath: "parent_id" },
        { name: "child_id", keyPath: "child_id" },
        { name: "edge", keyPath: ["parent_id", "child_id"] }
      ]
    },
    marriages: {
      keyPath: "id",
      indexes: [
        { name: "tree_id", keyPath: "tree_id" },
        { name: "spouse1_id", keyPath: "spouse1_id" },
        { name: "spouse2_id", keyPath: "spouse2_id" }
      ]
    },
    events: {
      keyPath: "id",
      indexes: [
        { name: "tree_id", keyPath: "tree_id" },
        { name: "type", keyPath: "type" },
        { name: "people", keyPath: "people", multiEntry: true }
      ]
    },
    media: {
      keyPath: "id",
      indexes: [
        { name: "tree_id", keyPath: "tree_id" },
        { name: "person_id", keyPath: "person_id" }
      ]
    },
    metadata: {
      keyPath: "key",
      indexes: []
    },
    deleted_items: {
      keyPath: "id",
      indexes: [{ name: "tree_id", keyPath: "tree_id" }]
    },
    history: {
      keyPath: "id",
      indexes: [{ name: "tree_id", keyPath: "tree_id" }]
    }
  };

  let _dbPromise = null;

  function sameKeyPath(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  function open() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        const upgradeTx = e.target.transaction;
        Object.keys(SCHEMA).forEach((storeName) => {
          const def = SCHEMA[storeName];
          let store;
          if (!db.objectStoreNames.contains(storeName)) {
            store = db.createObjectStore(storeName, { keyPath: def.keyPath });
          } else {
            store = upgradeTx.objectStore(storeName);
          }
          const wanted = new Set(def.indexes.map((ix) => ix.name));
          // drop stale / incorrectly-defined indexes
          Array.from(store.indexNames).forEach((existing) => {
            if (!wanted.has(existing)) { store.deleteIndex(existing); return; }
            const want = def.indexes.find((ix) => ix.name === existing);
            const cur = store.index(existing);
            if (!sameKeyPath(cur.keyPath, want.keyPath) ||
                !!cur.multiEntry !== !!want.multiEntry) {
              store.deleteIndex(existing);
            }
          });
          // (re)create any missing index
          def.indexes.forEach((ix) => {
            if (!store.indexNames.contains(ix.name)) {
              store.createIndex(ix.name, ix.keyPath, {
                unique: !!ix.unique, multiEntry: !!ix.multiEntry
              });
            }
          });
        });
      };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = (e) => reject(e.target.error);
      req.onblocked = () => reject(new Error("Database upgrade blocked — close other tabs and reload."));
    });
    return _dbPromise;
  }

  /* Promisify a raw IDBRequest. Used pervasively inside tx() callbacks. */
  function reqP(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = (e) => resolve(e.target.result);
      request.onerror = (e) => reject(e.target.error);
    });
  }

  async function get(storeName, key) {
    const t = typeof key;
    if (key == null || (t !== "string" && t !== "number")) {
      throw new Error("Invalid key for store " + storeName + ": " + JSON.stringify(key));
    }
    if (key === null || key === undefined) {
      throw new Error("Invalid key provided for store " + storeName + ": " + key);
    }
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction([storeName], "readonly");
      const r = t.objectStore(storeName).get(key);
      r.onsuccess = (e) => resolve(e.target.result);
      r.onerror = (e) => reject(e.target.error);
    });
  }

  async function put(storeName, value) {
    if (!value || typeof value !== "object") {
      throw new Error("Invalid value provided for store " + storeName);
    }
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction([storeName], "readwrite");
      const r = t.objectStore(storeName).put(value);
      r.onsuccess = (e) => resolve(e.target.result);
      r.onerror = (e) => reject(e.target.error);
    });
  }

  async function del(storeName, key) {
    if (key === null || key === undefined) {
      throw new Error("Invalid key for deletion from " + storeName + ": " + key);
    }
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction([storeName], "readwrite");
      const r = t.objectStore(storeName).delete(key);
      r.onsuccess = () => resolve(true);
      r.onerror = (e) => reject(e.target.error);
    });
  }

  async function getAll(storeName) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction([storeName], "readonly");
      const r = t.objectStore(storeName).getAll();
      r.onsuccess = (e) => resolve(e.target.result || []);
      r.onerror = (e) => reject(e.target.error);
    });
  }

  /* Read records by index (optionally bounded by a key range and a limit). */
  async function byIndex(storeName, indexName, keyRange, limit = 0) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction([storeName], "readonly");
      const index = t.objectStore(storeName).index(indexName);
      const r = index.openCursor(keyRange || null);
      const out = [];
      r.onsuccess = (e) => {
        const c = e.target.result;
        if (c && (!limit || out.length < limit)) { out.push(c.value); c.continue(); }
        else resolve(out);
      };
      r.onerror = (e) => reject(e.target.error);
    });
  }

  /* Paginated read over an index (or the primary store when indexName is null).
   * Signature matches the People list & Dashboard:
   *   page(store, indexName, keyRange, direction, offset, limit) */
  async function page(storeName, indexName, keyRange, direction = "next", offset = 0, limit = 50) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction([storeName], "readonly");
      const store = t.objectStore(storeName);
      const src = indexName ? store.index(indexName) : store;
      const r = src.openCursor(keyRange || null, direction);
      const out = [];
      let advanced = !offset;
      r.onsuccess = (e) => {
        const c = e.target.result;
        if (!c) return resolve(out);
        if (!advanced) { advanced = true; c.advance(offset); return; }
        out.push(c.value);
        if (limit && out.length >= limit) return resolve(out);
        c.continue();
      };
      r.onerror = (e) => reject(e.target.error);
    });
  }

  async function countByIndex(storeName, indexName, keyRange) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction([storeName], "readonly");
      const r = t.objectStore(storeName).index(indexName).count(keyRange || undefined);
      r.onsuccess = (e) => resolve(e.target.result);
      r.onerror = (e) => reject(e.target.error);
    });
  }

  /* Cursor scan over an index. callback(value) may return false to stop. */
  async function cursor(storeName, indexName, keyRange, direction = "next", callback) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction([storeName], "readonly");
      const index = t.objectStore(storeName).index(indexName);
      const r = index.openCursor(keyRange || null, direction);
      r.onsuccess = (e) => {
        const c = e.target.result;
        if (c) {
          if (callback(c.value) !== false) c.continue();
          else resolve();
        } else resolve();
      };
      r.onerror = (e) => reject(e.target.error);
    });
  }

  async function clearAll() {
    const db = await open();
    const names = Object.keys(SCHEMA).filter((n) => db.objectStoreNames.contains(n));
    return new Promise((resolve, reject) => {
      const t = db.transaction(names, "readwrite");
      names.forEach((n) => t.objectStore(n).clear());
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error("clearAll aborted"));
    });
  }

  /* Transaction wrapper.
   * callback(stores, transaction) — `stores` is a name->objectStore map (FIRST
   * argument, matching every caller's `(s) => s.persons…`). The promise resolves
   * with the callback's return value once the transaction COMMITS, and rejects
   * (aborting the transaction) if the callback throws/rejects. */
  async function tx(storeNames, mode, callback) {
    const db = await open();
    const names = Array.isArray(storeNames) ? storeNames : [storeNames];
    return new Promise((resolve, reject) => {
      let transaction;
      try { transaction = db.transaction(names, mode); }
      catch (err) { return reject(err); }

      const stores = {};
      names.forEach((n) => { stores[n] = transaction.objectStore(n); });

      let result, cbErr = null, settled = false;
      const finish = (fn, val) => { if (!settled) { settled = true; fn(val); } };

      Promise.resolve()
        .then(() => callback(stores, transaction))
        .then((r) => { result = r; })
        .catch((err) => { cbErr = err; try { transaction.abort(); } catch (_) {} });

      transaction.oncomplete = () => finish(resolve, result);
      transaction.onerror = () => finish(reject, cbErr || transaction.error);
      transaction.onabort = () => finish(reject, cbErr || transaction.error || new Error("Transaction aborted"));
    });
  }

  FT.DB = {
    open, get, put, del, getAll, byIndex, page,
    countByIndex, cursor, clearAll, tx, reqP
  };
})(window.FT);