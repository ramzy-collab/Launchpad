/* Formelab SDK: window.formelab (alias window.archie). No build step. */
(function () {
  "use strict";
  var mount = (function () {
    try {
      var p = new URL(document.baseURI).pathname;
      return p.endsWith("/") ? p : p.slice(0, p.lastIndexOf("/") + 1);
    } catch (e) {
      return "/";
    }
  })();

  function call(method, path, body, raw) {
    var headers = { "x-formelab-mount": mount };
    var opts = { method: method, headers: headers, credentials: "same-origin" };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      opts.body = raw ? body : JSON.stringify(body);
    }
    return fetch("/_api/" + path, opts).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) {}
        if (!res.ok) {
          var info = (data && data.error) || {};
          var err = new Error(info.message || "Request failed with status " + res.status);
          err.code = info.code || "http_" + res.status;
          err.status = res.status;
          err.hint = info.hint || "";
          throw err;
        }
        return data;
      });
    });
  }

  var enc = encodeURIComponent;

  // Installing the app (formelab.app): keeps the browser's install dialog for app.install().
  var bip = null;
  function changed() { window.dispatchEvent(new Event("formelab:installchange")); }
  addEventListener("beforeinstallprompt", function (e) { e.preventDefault(); bip = e; changed(); });
  addEventListener("appinstalled", function () { bip = null; changed(); });

  var formelab = {
    mount: mount,
    // The signed-in person, or null for someone who opened the app through its public link.
    me: function () { return call("GET", "me"); },
    // Sends a public-link visitor to sign in, then back to this page.
    signIn: function () {
      location.assign("/_platform/sign-in?return=" + enc(location.pathname + location.search + location.hash));
    },
    // Shared data (kv) and each person's private data (kv.mine) have the same calls.
    kv: (function () {
      function store(base) {
        return {
          get: function (key) {
            return call("GET", base + "/" + enc(key)).then(
              function (r) { return r.value; },
              function (e) { if (e.status === 404) return null; throw e; }
            );
          },
          set: function (key, value) {
            if (value === undefined) value = null;
            return call("PUT", base + "/" + enc(key), JSON.stringify(value), true);
          },
          list: function (prefix) {
            return call("GET", base + (prefix ? "?prefix=" + enc(prefix) : ""));
          },
          "delete": function (key) { return call("DELETE", base + "/" + enc(key)); }
        };
      }
      var kv = store("kv");
      kv.mine = store("me/kv");
      return kv;
    })(),
    // Form answers: anyone who can open the app sends them; only its owner and editors list them.
    responses: {
      submit: function (data) { return call("POST", "responses", data === undefined ? null : data); },
      list: function (o) {
        o = o || {};
        return call("GET", "responses?limit=" + enc(o.limit || 500) + (o.before ? "&before=" + enc(o.before) : ""));
      },
      "delete": function (id) { return call("DELETE", "responses/" + enc(id)); }
    },
    secrets: {
      set: function (name, value, opts) {
        return call("PUT", "secrets/" + enc(name), { value: value, hosts: opts && opts.hosts });
      },
      list: function () { return call("GET", "secrets"); },
      "delete": function (name) { return call("DELETE", "secrets/" + enc(name)); },
      proxy: function (name, req) {
        req = req || {};
        var body = req.body;
        if (body !== undefined && body !== null && typeof body !== "string") body = JSON.stringify(body);
        return call("POST", "secrets/" + enc(name) + "/proxy", {
          url: req.url, method: req.method, headers: req.headers, body: body
        }).then(function (r) {
          r.json = function () { return JSON.parse(r.text); };
          return r;
        });
      }
    },
    // Google Sheets through the app owner's connected Google account (Formelab: Connected apps).
    sheets: {
      available: function () { return call("GET", "sheets"); },
      request: function (method, path, options) {
        options = options || {};
        return call("POST", "sheets", { method: method, path: path, query: options.query, body: options.body }).then(function (r) { return r.data; });
      },
      read: function (spreadsheetId, range) {
        return formelab.sheets.request("GET", "spreadsheets/" + enc(spreadsheetId) + "/values/" + enc(range)).then(function (d) { return (d && d.values) || []; });
      },
      append: function (spreadsheetId, range, rows) {
        return formelab.sheets.request("POST", "spreadsheets/" + enc(spreadsheetId) + "/values/" + enc(range) + ":append",
          { query: { valueInputOption: "USER_ENTERED", insertDataOption: "INSERT_ROWS" }, body: { values: rows } });
      },
      update: function (spreadsheetId, range, rows) {
        return formelab.sheets.request("PUT", "spreadsheets/" + enc(spreadsheetId) + "/values/" + enc(range),
          { query: { valueInputOption: "USER_ENTERED" }, body: { values: rows } });
      },
      create: function (title) {
        return formelab.sheets.request("POST", "spreadsheets", { body: { properties: { title: title } } }).then(function (d) {
          return { id: d.spreadsheetId, url: d.spreadsheetUrl };
        });
      }
    },
    app: {
      installed: function () { return navigator.standalone === true || matchMedia("(display-mode: standalone)").matches; },
      canInstall: function () { return !!bip; },
      install: function () {
        var p = bip;
        bip = null;
        if (!p) return Promise.resolve("manual");
        p.prompt();
        return p.userChoice.then(function (c) { changed(); return c.outcome; });
      }
    },
    // Google Gemini through the app owner's connected key (Formelab: Connected apps).
    gemini: {
      available: function () { return call("GET", "ai/gemini"); },
      generate: function (prompt, options) {
        var req = typeof prompt === "string" ? Object.assign({}, options || {}, { prompt: prompt }) : (prompt || {});
        return call("POST", "ai/gemini", req).then(function (r) {
          r.json = function () { return JSON.parse(r.text); };
          return r;
        });
      }
    }
  };

  window.formelab = formelab;
  window.archie = formelab;
})();
