// Formelab dashboard. Served as a file so the page can use a strict CSP.
(function () {
  "use strict";
  var flash = document.getElementById("flash");

  function show(message, isError) {
    flash.textContent = message;
    flash.className = isError ? "error" : "ok";
    flash.hidden = false;
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function api(method, path, body) {
    var opts = { method: method, headers: { "x-formelab-request": "1" }, credentials: "same-origin" };
    if (body instanceof FormData) opts.body = body;
    else if (body !== undefined) {
      opts.headers["content-type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    return fetch("/_api/admin" + path, opts).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) {}
        if (!res.ok) {
          var err = (data && data.error) || { message: "Request failed (" + res.status + ")", hint: "" };
          throw new Error(err.message + (err.hint ? " " + err.hint : ""));
        }
        return data;
      });
    });
  }

  function busy(form, on) {
    var buttons = form.querySelectorAll("button");
    for (var i = 0; i < buttons.length; i++) buttons[i].disabled = on;
  }

  function reloadSoon() { setTimeout(function () { location.reload(); }, 900); }

  var handlers = {
    upload: function (form) {
      var fd = new FormData(form);
      fd.set("spa", form.elements.spa.checked ? "true" : "false");
      return api("POST", "/sites", fd).then(function (r) {
        show("Published: " + r.url);
        reloadSoon();
      });
    },
    "site-replace": function (form) {
      var fd = new FormData(form);
      fd.set("namespace", form.dataset.namespace);
      fd.set("mount_path", form.dataset.mount);
      return api("POST", "/sites", fd).then(function (r) {
        show("Replaced: " + r.url);
        reloadSoon();
      });
    },
    "site-update": function (form) {
      var el = form.elements;
      return api("PATCH", "/sites/" + encodeURIComponent(form.dataset.id), {
        title: el.title.value,
        visibility: el.visibility.value,
        allowed_emails: el.allowed_emails.value,
        editors: el.editors.value,
        spa: el.spa.checked,
        hidden: el.hidden.checked
      }).then(function () {
        show("Settings saved.");
        reloadSoon();
      });
    },
    "ns-create": function (form) {
      return api("POST", "/namespaces", { label: form.elements.label.value }).then(function () {
        show("Namespace created.");
        reloadSoon();
      });
    },
    "ns-editors": function (form) {
      return api("PATCH", "/namespaces/" + encodeURIComponent(form.dataset.label), { editors: form.elements.editors.value }).then(function () {
        show("Editors saved.");
      });
    },
    "token-create": function (form) {
      return api("POST", "/tokens", { name: form.elements.name.value, ttlHours: Number(form.elements.ttlHours.value) }).then(function (r) {
        document.getElementById("new-token-value").textContent = r.token;
        document.getElementById("new-token").hidden = false;
        form.reset();
        show("Token created. Copy it now; it is only shown once.");
      });
    }
  };

  document.addEventListener("submit", function (ev) {
    var form = ev.target;
    var h = handlers[form.dataset.action];
    if (!h) return;
    ev.preventDefault();
    busy(form, true);
    Promise.resolve()
      .then(function () { return h(form); })
      .catch(function (e) { show(e.message, true); })
      .then(function () { busy(form, false); });
  });

  document.addEventListener("click", function (ev) {
    var btn = ev.target.closest("button");
    if (!btn) return;
    var action = btn.dataset.action;
    var p = null;
    if (btn.dataset.copy) {
      var src = document.querySelector(btn.dataset.copy);
      navigator.clipboard.writeText(src.textContent.replace(/\\\n\s*/g, "")).then(function () {
        btn.textContent = "Copied";
        setTimeout(function () { btn.textContent = "Copy"; }, 1500);
      });
      return;
    }
    if (action === "site-delete") {
      var mount = btn.dataset.mount;
      var label = mount === "" ? "/" : mount;
      var typed = prompt("This permanently deletes " + btn.dataset.namespace + "/" + mount + " with its files, data and secrets.\nType the mount path (" + label + ") to confirm:");
      if (typed === null) return;
      if (typed.trim() !== label) { show("The mount path did not match; nothing was deleted.", true); return; }
      p = api("DELETE", "/sites/" + encodeURIComponent(btn.dataset.id)).then(function () { show("Site deleted."); reloadSoon(); });
    } else if (action === "ns-delete") {
      var typedNs = prompt("This permanently deletes the namespace " + btn.dataset.label + " and EVERY site in it.\nType the namespace name to confirm:");
      if (typedNs === null) return;
      if (typedNs.trim() !== btn.dataset.label) { show("The name did not match; nothing was deleted.", true); return; }
      p = api("DELETE", "/namespaces/" + encodeURIComponent(btn.dataset.label)).then(function () { show("Namespace deleted."); reloadSoon(); });
    } else if (action === "token-revoke") {
      if (!confirm("Revoke this token? Anything using it will stop working.")) return;
      p = api("DELETE", "/tokens/" + encodeURIComponent(btn.dataset.id)).then(function () { show("Token revoked."); reloadSoon(); });
    }
    if (p) {
      btn.disabled = true;
      p.catch(function (e) { show(e.message, true); }).then(function () { btn.disabled = false; });
    }
  });
})();
