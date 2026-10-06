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

  var formelab = {
    mount: mount,
    me: function () { return call("GET", "me"); },
    kv: {
      get: function (key) {
        return call("GET", "kv/" + enc(key)).then(
          function (r) { return r.value; },
          function (e) { if (e.status === 404) return null; throw e; }
        );
      },
      set: function (key, value) {
        if (value === undefined) value = null;
        return call("PUT", "kv/" + enc(key), JSON.stringify(value), true);
      },
      list: function (prefix) {
        return call("GET", "kv" + (prefix ? "?prefix=" + enc(prefix) : ""));
      },
      "delete": function (key) { return call("DELETE", "kv/" + enc(key)); }
    },
    secrets: {
      set: function (name, value) { return call("PUT", "secrets/" + enc(name), { value: value }); },
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
    }
  };

  window.formelab = formelab;
  window.archie = formelab;
})();
