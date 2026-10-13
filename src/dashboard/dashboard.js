// Formelab dashboard. Served as a file so the page can use a strict CSP.
(function () {
  "use strict";
  var flash = document.getElementById("flash");

  function show(message, isError) {
    // Inside an open dialog the page's own message line is hidden behind it, so use one in the dialog.
    var dialog = document.querySelector("dialog[open]");
    var target = flash;
    if (dialog) {
      target = dialog.querySelector(".dialog-flash");
      if (!target) {
        target = document.createElement("div");
        target.setAttribute("role", "status");
        target.className = "dialog-flash";
        dialog.querySelector(".howto").insertBefore(target, dialog.querySelector(".howto").children[1] || null);
      }
    }
    target.textContent = message;
    target.className = (dialog ? "dialog-flash " : "") + (isError ? "error" : "ok");
    target.hidden = false;
    if (!dialog) window.scrollTo({ top: 0, behavior: "smooth" });
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
          var error = new Error(err.message + (err.hint ? " " + err.hint : ""));
          error.code = err.code;
          throw error;
        }
        return data;
      });
    });
  }

  function busy(form, on) {
    var buttons = form.querySelectorAll("button");
    for (var i = 0; i < buttons.length; i++) buttons[i].disabled = on;
  }

  // A full-page loading screen (styles in formelab.css, .splash).
  function splash(text) {
    var el = document.createElement("div");
    el.className = "splash";
    el.setAttribute("role", "status");
    el.innerHTML = '<span class="splash-mark" aria-hidden="true">F</span><p class="splash-text"></p><span class="splash-bar" aria-hidden="true"></span>';
    el.querySelector(".splash-text").textContent = text;
    document.body.appendChild(el);
    requestAnimationFrame(function () { el.classList.add("on"); });
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
      var patch = {
        title: el.title.value,
        visibility: el.visibility.value,
        allowed_emails: el.allowed_emails.value,
        data_writes: el.data_writes.value,
        spa: el.spa.checked,
        hidden: el.hidden.checked
      };
      // Only the owner sees (and may change) the editors field.
      if (el.editors) patch.editors = el.editors.value;
      // Likewise the Google Sheets the app may use (the owner's Google account).
      if (el.sheets) patch.sheets = el.sheets.value;
      return api("PATCH", "/sites/" + encodeURIComponent(form.dataset.id), patch).then(function () {
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
    "feature-set": function (form) {
      return api("PUT", "/features/" + encodeURIComponent(form.dataset.name), { state: form.elements.state.value }).then(function () {
        show("Saved. It applies right away.");
        reloadSoon();
      });
    },
    "feature-user-add": function (form) {
      var email = form.elements.email.value.trim();
      return api("POST", "/features/" + encodeURIComponent(form.dataset.name) + "/users", { email: email }).then(function () {
        show("Turned on for " + email + ". It applies right away.");
        reloadSoon();
      });
    },
    "service-connect": function (form) {
      return api("PUT", "/services/" + encodeURIComponent(form.dataset.service), { apiKey: form.elements.apiKey.value.trim() }).then(function () {
        form.reset();
        show("Connected. Your apps can use it now.");
        reloadSoon();
      });
    },
    "password-set": function (form) {
      if (form.elements.password.value !== form.elements.confirm.value) {
        show("The two passwords don't match.", true);
        return;
      }
      return api("PUT", "/account/password", { password: form.elements.password.value }).then(
        function () {
          form.reset();
          show("Password saved. You can log in with your email and this password now.");
        },
        function (e) {
          // The sign-in got too old while the page was open: reload to ask for a fresh one.
          if (e.code === "reauth_required") reloadSoon();
          throw e;
        }
      );
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
    // Log out in the background, then go where the server says (the WorkOS logout, then home),
    // without a page in between. If that fails, the form posts the usual way.
    if (form.classList.contains("logout")) {
      ev.preventDefault();
      busy(form, true);
      splash("Logging you out…");
      // Keep the splash up long enough to read, even when the server answers at once.
      var shown = new Promise(function (resolve) { setTimeout(resolve, 900); });
      fetch(form.action, { method: "POST", headers: { "x-formelab-request": "1" }, credentials: "same-origin" })
        .then(function (res) { return res.ok ? res.json() : Promise.reject(); })
        .then(function (r) { return shown.then(function () { location.assign(r.to); }); })
        .catch(function () { form.submit(); });
      return;
    }
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

  // New app: hand the idea to Claude or ChatGPT in a new tab, or copy it for Claude Code.
  var MAKE_URLS = { claude: "https://claude.ai/new?q=", chatgpt: "https://chatgpt.com/?q=" };
  function makePrompt(idea) {
    return /formelab/i.test(idea) ? idea : idea + "\n\nBuild this as a web app and publish it to Formelab.";
  }
  document.addEventListener("click", function (ev) {
    var idea = ev.target.closest("[data-idea]");
    var box = document.getElementById("idea");
    if (idea && box) { box.value = idea.dataset.idea; box.focus(); return; }
    var make = ev.target.closest("[data-make]");
    if (!make || !box) return;
    var text = box.value.trim();
    if (!text) { show("Describe your app first, or pick one of the ideas.", true); box.focus(); return; }
    var prompt = makePrompt(text);
    if (make.dataset.make === "copy") {
      navigator.clipboard.writeText(prompt).then(function () {
        show("Copied. Paste it into Claude Code and press enter.");
      });
      return;
    }
    window.open(MAKE_URLS[make.dataset.make] + encodeURIComponent(prompt), "_blank", "noopener");
  });

  // App browser (My apps, Shared with me): search, filters, sort, and tiles or list.
  var VIEW_KEY = "formelab:apps-view";
  function initBrowser(root) {
    var state = { key: "updated", dir: "desc", view: "tiles" };
    try { if (localStorage.getItem(VIEW_KEY) === "list") state.view = "list"; } catch (e) {}
    var q = root.querySelector("[data-q]");
    var sortSel = root.querySelector("[data-sort-select]");
    var filters = root.querySelectorAll("[data-filter]");

    function value(el, key) {
      var v = el.dataset[key] || "";
      return key === "updated" || key === "size" ? Number(v) : v;
    }
    function matches(el) {
      var text = (q.value || "").trim().toLowerCase();
      if (text && el.dataset.search.indexOf(text) === -1) return false;
      for (var i = 0; i < filters.length; i++) {
        var f = filters[i];
        if (f.value && el.dataset[f.dataset.filter] !== f.value) return false;
      }
      return true;
    }
    function compare(a, b) {
      var x = value(a, state.key), y = value(b, state.key);
      var c = typeof x === "number" ? x - y : String(x).localeCompare(String(y));
      if (c === 0 && state.key !== "name") c = value(a, "name").localeCompare(value(b, "name"));
      return state.dir === "asc" ? c : -c;
    }
    function sortChildren(container) {
      var items = Array.prototype.slice.call(container.querySelectorAll(":scope > [data-app]"));
      items.sort(compare).forEach(function (el) { container.appendChild(el); });
    }
    function apply() {
      var shown = 0;
      root.querySelectorAll("[data-app]").forEach(function (el) {
        var ok = matches(el);
        el.hidden = !ok;
        if (ok && el.tagName !== "TR") shown++;
      });
      root.querySelectorAll(".tiles, tbody").forEach(sortChildren);
      root.querySelectorAll("[data-group]").forEach(function (g) { g.hidden = !g.querySelector(".tile:not([hidden])"); });
      root.querySelector("[data-no-match]").hidden = shown > 0;
      root.querySelectorAll("th[aria-sort]").forEach(function (th) {
        var k = th.querySelector("[data-sort]").dataset.sort;
        th.setAttribute("aria-sort", k === state.key ? (state.dir === "asc" ? "ascending" : "descending") : "none");
      });
      var opt = state.key + ":" + state.dir;
      sortSel.value = sortSel.querySelector('option[value="' + opt + '"]') ? opt : sortSel.value;
      root.dataset.view = state.view;
      root.querySelector(".view-tiles").hidden = state.view !== "tiles";
      root.querySelector(".view-list").hidden = state.view !== "list";
      root.querySelectorAll("[data-view]").forEach(function (b) {
        if (b !== root) b.setAttribute("aria-pressed", b.dataset.view === state.view ? "true" : "false");
      });
    }
    q.addEventListener("input", apply);
    filters.forEach(function (f) { f.addEventListener("change", apply); });
    // A space's link (?space=<name>) opens the list filtered to that space.
    var wanted = new URLSearchParams(location.search).get("space");
    var spaceSel = root.querySelector('[data-filter="space"]');
    if (wanted && spaceSel && [].some.call(spaceSel.options, function (o) { return o.value === wanted; })) {
      spaceSel.value = wanted;
      apply();
    }
    sortSel.addEventListener("change", function () {
      var parts = sortSel.value.split(":");
      state.key = parts[0]; state.dir = parts[1];
      apply();
    });
    root.addEventListener("click", function (ev) {
      var head = ev.target.closest("[data-sort]");
      if (head) {
        var k = head.dataset.sort;
        if (state.key === k) state.dir = state.dir === "asc" ? "desc" : "asc";
        else { state.key = k; state.dir = k === "updated" || k === "size" ? "desc" : "asc"; }
        apply();
        return;
      }
      var v = ev.target.closest("button[data-view]");
      if (v) {
        state.view = v.dataset.view;
        try { localStorage.setItem(VIEW_KEY, state.view); } catch (e) {}
        apply();
      }
    });
    apply();
  }
  document.querySelectorAll("[data-browser]").forEach(initBrowser);

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
      var after = btn.dataset.next;
      p = api("DELETE", "/sites/" + encodeURIComponent(btn.dataset.id)).then(function () {
        show("App deleted.");
        setTimeout(function () { if (after) location.href = after; else location.reload(); }, 900);
      });
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
    } else if (action === "feature-user-remove") {
      if (!confirm("Stop turning this feature on for " + btn.dataset.email + "? They keep it if it's on for everyone (or for admins, and they're one).")) return;
      p = api("DELETE", "/features/" + encodeURIComponent(btn.dataset.name) + "/users/" + encodeURIComponent(btn.dataset.email)).then(function () {
        show("Removed " + btn.dataset.email + ".");
        reloadSoon();
      });
    } else if (action === "waitlist-approve") {
      p = api("POST", "/waitlist/approve", { email: btn.dataset.email }).then(function () { show("Let in. They can create apps now."); reloadSoon(); });
    } else if (action === "connection-revoke") {
      if (!confirm("Disconnect this app? It will need to sign in again to use Formelab.")) return;
      p = api("DELETE", "/connections/" + encodeURIComponent(btn.dataset.id)).then(function () { show("Disconnected."); reloadSoon(); });
    } else if (action === "service-disconnect") {
      if (!confirm("Disconnect? Your apps that use it will stop working until you connect it again.")) return;
      p = api("DELETE", "/services/" + encodeURIComponent(btn.dataset.service)).then(function () { show("Disconnected."); reloadSoon(); });
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
