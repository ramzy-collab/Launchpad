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
      // Unchecked means "leave as is" when publishing a new version of an existing app.
      if (form.elements.spa.checked) fd.set("spa", "true");
      else fd.delete("spa");
      return api("POST", "/sites", fd).then(function (r) {
        show((r.replaced ? "Published a new version: " : "It's live: ") + r.url + (r.replaced ? " (sharing settings kept)" : ""));
        var next = form.dataset.next;
        setTimeout(function () { if (next) location.href = next; else location.reload(); }, 1200);
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
        show("Space created.");
        reloadSoon();
      });
    },
    "ns-editors": function (form) {
      return api("PATCH", "/namespaces/" + encodeURIComponent(form.dataset.label), { editors: form.elements.editors.value }).then(function () {
        show("Editors saved.");
      });
    },
    "waitlist-invite": function (form) {
      return api("POST", "/waitlist/approve", { email: form.elements.email.value }).then(function () {
        show("Invited. They can create apps as soon as they log in.");
        reloadSoon();
      });
    },
    "token-create": function (form) {
      return api("POST", "/tokens", { name: form.elements.name.value, ttlHours: Number(form.elements.ttlHours.value) }).then(function (r) {
        document.getElementById("new-token-value").textContent = r.token;
        document.getElementById("new-token").hidden = false;
        form.reset();
        show("Key created. Copy it now; it is only shown once.");
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

  // Connect your AI: each tile opens its setup steps in a dialog; /connect#claude opens one directly.
  function openDialog(id) {
    var d = document.getElementById(id);
    if (d && typeof d.showModal === "function" && !d.open) d.showModal();
  }
  document.addEventListener("click", function (ev) {
    var tile = ev.target.closest("[data-dialog]");
    if (tile) { openDialog(tile.dataset.dialog); return; }
    // A click on the backdrop (outside the dialog's box) closes it.
    if (ev.target.tagName === "DIALOG") ev.target.close();
  });
  if (location.hash.length > 1) openDialog("dlg-" + location.hash.slice(1));

  // The left menu on narrow screens.
  document.addEventListener("click", function (ev) {
    var toggle = ev.target.closest("[data-menu-toggle]");
    if (!toggle) return;
    var open = document.body.classList.toggle("menu-open");
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
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
      var typedNs = prompt("This permanently deletes the space " + btn.dataset.label + " and EVERY app in it.\nType the space name to confirm:");
      if (typedNs === null) return;
      if (typedNs.trim() !== btn.dataset.label) { show("The name did not match; nothing was deleted.", true); return; }
      p = api("DELETE", "/namespaces/" + encodeURIComponent(btn.dataset.label)).then(function () { show("Space deleted."); reloadSoon(); });
    } else if (action === "user-delete") {
      var who = btn.dataset.email;
      var typedUser = prompt("This permanently deletes " + who + " and everything they own: " + btn.dataset.apps + " app(s), their namespaces, data and secrets. It can't be undone.\nType their email to confirm:");
      if (typedUser === null) return;
      if (typedUser.trim().toLowerCase() !== who) { show("The email did not match; nothing was deleted.", true); return; }
      p = api("DELETE", "/users/" + encodeURIComponent(who)).then(function (r) {
        show("Deleted " + who + (r.deletedSites ? " and " + r.deletedSites + " app(s)." : "."));
        reloadSoon();
      });
    } else if (action === "user-admin") {
      var grant = btn.dataset.admin === "true";
      if (!confirm(grant ? "Make " + btn.dataset.email + " an admin? They'll be able to manage everyone on Formelab." : "Remove admin access from " + btn.dataset.email + "?")) return;
      p = api("POST", "/users/" + encodeURIComponent(btn.dataset.email) + "/admin", { admin: grant }).then(function () {
        show(grant ? btn.dataset.email + " is now an admin." : btn.dataset.email + " is no longer an admin.");
        reloadSoon();
      });
    } else if (action === "waitlist-approve") {
      p = api("POST", "/waitlist/approve", { email: btn.dataset.email }).then(function () { show("Let in. They can create apps now."); reloadSoon(); });
    } else if (action === "connection-revoke") {
      if (!confirm("Disconnect this app? It will need to sign in again to use Formelab.")) return;
      p = api("DELETE", "/connections/" + encodeURIComponent(btn.dataset.id)).then(function () { show("Disconnected."); reloadSoon(); });
    } else if (action === "token-revoke") {
      if (!confirm("Revoke this key? Anything using it will stop working.")) return;
      p = api("DELETE", "/tokens/" + encodeURIComponent(btn.dataset.id)).then(function () { show("Key revoked."); reloadSoon(); });
    }
    if (p) {
      btn.disabled = true;
      p.catch(function (e) { show(e.message, true); }).then(function () { btn.disabled = false; });
    }
  });
})();
