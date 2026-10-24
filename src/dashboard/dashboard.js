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
    return el;
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
    "ns-create": function (form) {
      return api("POST", "/namespaces", { label: form.elements.label.value }).then(function () {
        show("Space created.");
        reloadSoon();
      });
    },
    "ns-editors": function (form) {
      return api("PATCH", "/namespaces/" + encodeURIComponent(form.dataset.label), { editors: form.elements.editors.value }).then(function (r) {
        show(r && r.note ? r.note : "Editors saved.");
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
    "connector-create": function (form) {
      var f = form.elements;
      return api("POST", "/connectors", {
        label: f.label.value, description: f.description.value, key: f.key.value,
        hosts: f.hosts.value, auth: f.auth.value, authName: f.authName.value
      }).then(function (k) {
        flashNext(k.label + " is ready. Ask your AI to use it in an app.");
        location.href = "/connected/" + encodeURIComponent(k.name);
      });
    },
    "connector-key": function (form) {
      return api("PATCH", "/connectors/" + encodeURIComponent(form.dataset.name), { key: form.elements.key.value }).then(function () {
        form.reset();
        flashNext("Key replaced. Apps use the new one from now on.");
        location.reload();
      });
    },
    "gemini-limit": function (form) {
      return api("PATCH", "/services/gemini", { dailyLimit: form.elements.dailyLimit.value }).then(function () {
        show("Daily limit saved.");
        reloadSoon();
      });
    },
    "builder-connect": function (form) {
      return api("PUT", "/builders/" + encodeURIComponent(form.dataset.provider), { apiKey: form.elements.apiKey.value.trim() }).then(function () {
        form.reset();
        show("Key saved. Describe your app and press Make it.");
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
  var MAKE_URLS = { claude: "https://claude.ai/new?q=", chatgpt: "https://chatgpt.com/?q=", grok: "https://grok.com/?q=" };
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

  // New app, built here: the person's own API key builds the app on the server, which streams
  // progress lines ({ progress } ... then { done } or { error }) and publishes it.
  var BUILDER_NAMES = { claude: "Claude", openai: "ChatGPT", gemini: "Gemini", grok: "Grok" };
  function dataChoice() {
    var sel = document.getElementById("build-data-writes");
    return sel ? sel.value : "auto";
  }
  // A new app is live: say who can change its data (and why, when Formelab chose), with a way to change it.
  function built(screen, sub, done) {
    screen.classList.add("done");
    screen.querySelector(".splash-text").textContent = "It's live: " + done.title;
    var everyone = done.dataWrites.value === "everyone";
    sub.textContent = "Who can change its data: " + (everyone ? "everyone who can open it" : "only you and editors") + "." +
      (done.dataWrites.chosen === "auto"
        ? everyone ? " Formelab chose this because the app saves things people share, like votes or sign-ups." : " Formelab chose this because the app doesn't save shared data for everyone."
        : "");
    var row = document.createElement("p");
    row.className = "splash-actions";
    var open = document.createElement("a");
    open.className = "cta";
    open.href = done.url;
    open.textContent = "Open app";
    var settings = document.createElement("a");
    settings.href = "/apps/" + encodeURIComponent(done.siteId);
    settings.textContent = "Change it in settings";
    row.appendChild(open);
    row.appendChild(document.createTextNode(" "));
    row.appendChild(settings);
    screen.appendChild(row);
    open.focus();
  }
  function build(provider, idea, siteId) {
    var screen = splash(BUILDER_NAMES[provider] + (siteId ? " is changing your app…" : " is building your app…"));
    var sub = document.createElement("p");
    sub.className = "splash-sub";
    sub.textContent = "This usually takes a minute or two. You can leave this page; the app will still be published.";
    screen.appendChild(sub);
    function fail(message) {
      screen.remove();
      show(message, true);
    }
    var finished = false;
    function handle(line) {
      if (!line.trim()) return;
      var msg;
      try { msg = JSON.parse(line); } catch (e) { return; }
      if (msg.error) { finished = true; fail(msg.error.message + (msg.error.hint ? " " + msg.error.hint : "")); }
      else if (msg.done) {
        finished = true;
        if (msg.done.dataWrites && msg.done.siteId) { built(screen, sub, msg.done); return; }
        screen.querySelector(".splash-text").textContent = (siteId ? "Updated! Opening " : "It's live! Opening ") + msg.done.title + "…";
        sub.textContent = "";
        setTimeout(function () { location.href = msg.done.url; }, 900);
      } else if (msg.progress) {
        sub.textContent = "Writing it now: " + msg.progress.toLocaleString() + " characters so far.";
      }
    }
    fetch("/_api/admin/build", {
      method: "POST",
      credentials: "same-origin",
      headers: { "x-formelab-request": "1", "content-type": "application/json" },
      body: JSON.stringify(siteId ? { provider: provider, site_id: siteId, change: idea } : { provider: provider, idea: idea, data_writes: dataChoice() })
    }).then(function (res) {
      if (!res.ok || !res.body) {
        return res.json().then(function (d) { throw new Error(d.error.message + (d.error.hint ? " " + d.error.hint : "")); }, function () { throw new Error("Request failed (" + res.status + ")"); });
      }
      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buf = "";
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) { handle(buf); if (!finished) fail("The build stopped before it finished. Check My lab in a minute, or try again."); return; }
          buf += decoder.decode(r.value, { stream: true });
          var lines = buf.split("\n");
          buf = lines.pop();
          lines.forEach(handle);
          return pump();
        });
      }
      return pump();
    }).catch(function (e) {
      if (!finished) fail(e.message || "The build failed. Try again.");
    });
  }
  document.addEventListener("click", function (ev) {
    var btn = ev.target.closest("[data-build]");
    if (!btn) return;
    // The description box in the same section: the new app idea, or the change to an app.
    var box = btn.closest("section").querySelector("textarea");
    if (!box) return;
    var text = box.value.trim();
    var siteId = btn.dataset.site;
    if (!text) { show(siteId ? "Say what to change first." : "Describe your app first, or pick one of the ideas.", true); box.focus(); return; }
    build(btn.dataset.build, text, siteId);
  });

  // A short message at the bottom of the screen: "Saved", "Link copied". Errors stay up longer.
  var toastEl = document.getElementById("toast");
  var toastTimer;
  function toast(message, isError) {
    if (!toastEl) { show(message, isError); return; }
    toastEl.textContent = message;
    toastEl.className = "toast" + (isError ? " error" : "");
    toastEl.hidden = false;
    requestAnimationFrame(function () { toastEl.classList.add("on"); });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastEl.classList.remove("on");
      setTimeout(function () { toastEl.hidden = true; }, 250);
    }, isError ? 6000 : message.length > 60 ? 4000 : 2200);
  }

  // A message to show on the next page, after a reload or navigation.
  var FLASH_KEY = "formelab:flash";
  function flashNext(message) { try { sessionStorage.setItem(FLASH_KEY, message); } catch (e) {} }
  (function () {
    var m = null;
    try { m = sessionStorage.getItem(FLASH_KEY); sessionStorage.removeItem(FLASH_KEY); } catch (e) {}
    if (m) setTimeout(function () { toast(m); }, 300);
  })();

  function copyText(text, message) {
    var done = function () { toast(message); };
    var fail = function () { toast("Couldn't copy the link. Copy it from the app's address bar instead.", true); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fail);
    else fail();
  }

  // Who can open a link, for the toast after copying it.
  function copiedMessage(access, sharedCount) {
    if (access === "public") return "Link copied. Anyone with it can open the app.";
    if (access === "members") return "Link copied. Anyone signed in to Formelab can open it.";
    if (sharedCount > 0) return "Link copied. Only people you invited can open it.";
    return "Link copied. Only you can open it right now.";
  }

  // Stars are saved per person. Stars kept in this browser before that are moved over once.
  var OLD_STARS_KEY = "formelab:stars";
  function saveStar(id, on) {
    return api("PUT", "/sites/" + encodeURIComponent(id) + "/star", { starred: on });
  }
  function takeOldStars() {
    var list = [];
    try { list = JSON.parse(localStorage.getItem(OLD_STARS_KEY) || "[]") || []; localStorage.removeItem(OLD_STARS_KEY); } catch (e) {}
    return Array.isArray(list) ? list : [];
  }
  function paintStar(btn, on) {
    btn.classList.toggle("on", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.title = on ? "Unstar" : "Star";
  }

  // App browser (My apps, Shared with me): starred cards first, then search, space and sort.
  function initBrowser(root) {
    var q = root.querySelector("[data-q]");
    var space = root.querySelector('[data-filter="space"]');
    var sortSel = root.querySelector("[data-sort-select]");
    var cards = Array.prototype.slice.call(root.querySelectorAll("[data-app]"));
    var starredGroup = root.querySelector("[data-starred]");
    var starredBox = root.querySelector("[data-starred-cards]");
    var restGroup = root.querySelector("[data-rest]");
    var restBox = root.querySelector("[data-rest-cards]");
    var restHead = root.querySelector("[data-rest-head]");
    var hint = root.querySelector("[data-star-hint]");
    var noMatch = root.querySelector("[data-no-match]");
    var dot = root.querySelector("[data-filters-dot]");
    var filtersToggle = root.querySelector("[data-filters-toggle]");
    filtersToggle.addEventListener("click", function () {
      var open = root.classList.toggle("filters-open");
      filtersToggle.setAttribute("aria-expanded", open ? "true" : "false");
    });
    var SORTS = {
      updated: function (a, b) { return Number(b.dataset.updated) - Number(a.dataset.updated); },
      created: function (a, b) { return Number(b.dataset.created) - Number(a.dataset.created); },
      name: function (a, b) { return a.dataset.name.localeCompare(b.dataset.name); }
    };

    function apply() {
      var raw = q.value.trim();
      var text = raw.toLowerCase();
      var sp = space ? space.value : "";
      var shown = cards.filter(function (el) {
        return (!sp || el.dataset.space === sp) && (!text || el.dataset.search.indexOf(text) !== -1);
      });
      shown.sort(SORTS[sortSel.value] || SORTS.updated);
      var starred = [];
      var rest = [];
      cards.forEach(function (el) { el.hidden = true; });
      shown.forEach(function (el) {
        var on = !!stars[el.dataset.id];
        paintStar(el.querySelector("[data-star]"), on);
        el.hidden = false;
        (on ? starred : rest).push(el);
      });
      starred.forEach(function (el) { starredBox.appendChild(el); });
      rest.forEach(function (el) { restBox.appendChild(el); });
      var filtering = !!text || !!sp;
      starredGroup.hidden = !shown.length || (filtering && !starred.length);
      hint.hidden = starred.length > 0;
      restGroup.hidden = !rest.length;
      restHead.hidden = false;
      restHead.textContent = starred.length ? "Everything else" : filtering ? "Results" : "All apps";
      noMatch.hidden = shown.length > 0;
      // On a phone the filters fold behind one button; a dot on it says one is in use.
      dot.hidden = !sp && sortSel.value === "updated";
      noMatch.querySelector("[data-no-match-text]").textContent = raw ? "Nothing matches “" + raw + "”" : "No apps in this space yet";
    }

    var stars = {};
    cards.forEach(function (el) { if (el.querySelector('[data-star][aria-pressed="true"]')) stars[el.dataset.id] = true; });
    takeOldStars().forEach(function (id) {
      if (stars[id] || !cards.some(function (el) { return el.dataset.id === id; })) return;
      stars[id] = true;
      saveStar(id, true).catch(function () { delete stars[id]; apply(); });
    });
    q.addEventListener("input", apply);
    if (space) space.addEventListener("change", apply);
    sortSel.addEventListener("change", apply);
    // A space's link (?space=<name>) opens the list filtered to that space.
    var wanted = new URLSearchParams(location.search).get("space");
    if (wanted && space && [].some.call(space.options, function (o) { return o.value === wanted; })) space.value = wanted;
    root.addEventListener("click", function (ev) {
      if (ev.target.closest("[data-clear]")) {
        q.value = "";
        if (space) space.value = "";
        apply();
        q.focus();
        return;
      }
      var card = ev.target.closest("[data-app]");
      if (!card) return;
      var star = ev.target.closest("[data-star]");
      if (star) {
        var id = card.dataset.id;
        var on = !stars[id];
        if (on) stars[id] = true; else delete stars[id];
        apply();
        star.focus();
        saveStar(id, on).then(function () {
          toast(on ? card.querySelector(".ac-name").textContent + " starred" : "Removed from starred");
        }, function (e) {
          if (on) delete stars[id]; else stars[id] = true;
          apply();
          toast(e.message, true);
        });
        return;
      }
      if (ev.target.closest("[data-copy-link]")) {
        copyText(card.dataset.copyUrl, card.dataset.access ? copiedMessage(card.dataset.access, Number(card.dataset.sharedN)) : "Link copied");
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
    if (action === "ns-delete") {
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
    } else if (action === "builder-disconnect") {
      if (!confirm(btn.dataset.provider === "gemini"
        ? "Remove your Gemini key? It's also the key under Connected apps, so your apps stop using Gemini until you add one again."
        : "Remove your API key? Make it will ask for a key again.")) return;
      p = api("DELETE", "/builders/" + encodeURIComponent(btn.dataset.provider)).then(function () { show("Key removed."); reloadSoon(); });
    } else if (action === "service-disconnect") {
      if (!confirm("Disconnect? Your apps that use it will stop working until you connect it again.")) return;
      p = api("DELETE", "/services/" + encodeURIComponent(btn.dataset.service)).then(function () { show("Disconnected."); reloadSoon(); });
    } else if (action === "connector-delete") {
      var apps = Number(btn.dataset.apps) || 0;
      if (!confirm("Delete " + btn.dataset.label + "? " + (apps ? apps + (apps === 1 ? " app stops" : " apps stop") + " being able to use it. " : "") + "The key is deleted and can't be brought back.")) return;
      p = api("DELETE", "/connectors/" + encodeURIComponent(btn.dataset.name)).then(function () {
        flashNext(btn.dataset.label + " deleted");
        location.href = "/connected";
      });
    } else if (action === "keys-move") {
      p = api("POST", "/connectors/saved-keys").then(function (r) {
        var n = r.moves.length;
        flashNext(n === 1 ? "Done. " + r.moves[0].name + " is a connector now." : "Done. Your saved keys are " + n + " connectors now.");
        location.reload();
      });
    } else if (action === "token-revoke") {
      if (!confirm("Revoke this key? Anything using it will stop working.")) return;
      p = api("DELETE", "/tokens/" + encodeURIComponent(btn.dataset.id)).then(function () { show("Key revoked."); reloadSoon(); });
    }
    if (p) {
      btn.disabled = true;
      p.catch(function (e) { show(e.message, true); }).then(function () { btn.disabled = false; });
    }
  });

  // Custom connectors: the name apps use follows the name typed; the header or parameter field shows
  // only when the key goes in one; on a connector's page, settings save as they change.
  (function () {
    var label = document.querySelector("[data-connector-label]");
    var slug = document.querySelector("[data-connector-slug]");
    function slugOf(v) {
      return v.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
    }
    if (label && slug) {
      var paint = function () { slug.textContent = slugOf(label.value) || "…"; };
      label.addEventListener("input", paint);
      paint();
    }
    var auth = document.querySelector("[data-connector-auth]");
    var authName = document.querySelector("[data-connector-auth-name]");
    function paintAuth() {
      if (!auth || !authName) return;
      var needs = auth.value === "header" || auth.value === "query";
      authName.hidden = !needs;
      authName.firstChild.textContent = auth.value === "query" ? "Query parameter" : "Header";
      var input = authName.querySelector("input");
      input.placeholder = auth.value === "query" ? "api_key" : "X-API-Key";
      input.required = needs;
    }
    if (auth) auth.addEventListener("change", paintAuth);
    var box = document.querySelector("[data-connector-settings]");
    if (!box) return;
    var saved = {};
    Array.prototype.forEach.call(box.querySelectorAll("input, select"), function (el) { saved[el.name] = el.value; });
    function save(el) {
      if (el.value === saved[el.name]) return;
      var body = {};
      if (el.name === "auth" || el.name === "authName") {
        body.auth = box.querySelector("[name=auth]").value;
        body.authName = box.querySelector("[name=authName]").value;
        // Waits for the header or parameter's name before saving.
        if ((body.auth === "header" || body.auth === "query") && !body.authName.trim()) { box.querySelector("[name=authName]").focus(); return; }
      } else {
        body[el.name] = el.value;
      }
      api("PATCH", "/connectors/" + encodeURIComponent(box.dataset.name), body).then(function () {
        saved[el.name] = el.value;
        if (body.auth) { saved.auth = body.auth; saved.authName = body.authName; }
        toast("Saved");
      }, function (e) { toast(e.message, true); });
    }
    box.addEventListener("change", function (ev) {
      if (ev.target.name === "auth") paintAuth();
      if (ev.target.name) save(ev.target);
    });
  })();

  // Close buttons inside dialogs.
  document.addEventListener("click", function (ev) {
    var close = ev.target.closest("[data-close]");
    if (close && close.closest("dialog")) close.closest("dialog").close();
  });

  // ---------- The role picker (People on an app's page) ----------
  // A listbox under its button: arrow keys, Home and End move, Esc and a click outside close it.
  var ROLES = {
    viewer: ["Viewer", "Can open and use the app"],
    editor: ["Editor", "Can edit the app and its data"],
    admin: ["Admin", "Can edit and manage sharing"]
  };
  var CHEVRON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
  var roleMenu = null;
  var viewersCanWrite = function () { return false; };

  function closeRoles(refocus) {
    if (!roleMenu) return;
    var btn = roleMenu.btn;
    btn.setAttribute("aria-expanded", "false");
    roleMenu.el.remove();
    roleMenu = null;
    if (refocus && btn.isConnected) btn.focus();
  }

  // `makeOwner`: null, or whether this person can be made the owner (only Admins with an account).
  function openRoles(btn, onPick, withRemove, makeOwner) {
    if (roleMenu && roleMenu.btn === btn) { closeRoles(true); return; }
    closeRoles(false);
    var allowed = (btn.dataset.roles || "viewer").split(",");
    var current = btn.dataset.role;
    var menu = document.createElement("div");
    menu.className = "rp-menu";
    menu.setAttribute("role", "listbox");
    menu.setAttribute("aria-label", btn.getAttribute("aria-label") || "Role");
    function option(value, label, desc, cls) {
      var b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "option");
      b.dataset.v = value;
      if (cls) b.className = cls;
      b.setAttribute("aria-selected", value === current ? "true" : "false");
      b.innerHTML = '<span class="rp-check" aria-hidden="true"></span><span class="rp-text"><b></b><small></small></span>';
      b.querySelector(".rp-check").textContent = value === current ? "✓" : "";
      b.querySelector("b").textContent = label;
      b.querySelector("small").textContent = desc;
      if (!desc) b.querySelector("small").remove();
      menu.appendChild(b);
      return b;
    }
    Object.keys(ROLES).forEach(function (v) {
      var off = allowed.indexOf(v) === -1;
      var desc = v === "viewer" && viewersCanWrite() ? "Can use the app and change its data" : ROLES[v][1];
      var b = option(v, ROLES[v][0], off ? "Only the owner can give this role" : desc);
      if (off) b.disabled = true;
    });
    if (withRemove || makeOwner != null) menu.appendChild(document.createElement("hr"));
    if (makeOwner != null) {
      var mo = option("owner", "Make owner", makeOwner ? "Hand over the app. You stay an Admin." : "Only Admins can become the owner");
      if (!makeOwner) mo.disabled = true;
    }
    if (withRemove) option("remove", "Remove access", "", "red");
    document.body.appendChild(menu);
    btn.setAttribute("aria-expanded", "true");
    roleMenu = { el: menu, btn: btn };
    placeRoles();
    var items = Array.prototype.slice.call(menu.querySelectorAll("button:not([disabled])"));
    menu.addEventListener("click", function (ev) {
      var b = ev.target.closest("button[data-v]");
      if (!b || b.disabled) return;
      closeRoles(true);
      if (b.dataset.v !== current) onPick(b.dataset.v);
    });
    menu.addEventListener("keydown", function (ev) {
      var i = items.indexOf(document.activeElement);
      var to = ev.key === "ArrowDown" ? (i + 1) % items.length
        : ev.key === "ArrowUp" ? (i - 1 + items.length) % items.length
        : ev.key === "Home" ? 0 : ev.key === "End" ? items.length - 1 : -1;
      if (to !== -1) { ev.preventDefault(); items[to].focus(); }
      if (ev.key === "Tab") closeRoles(false);
    });
    (menu.querySelector('[aria-selected="true"]:not([disabled])') || items[0]).focus();
  }

  document.addEventListener("mousedown", function (ev) {
    if (roleMenu && !roleMenu.el.contains(ev.target) && !roleMenu.btn.contains(ev.target)) closeRoles(false);
  });
  // Under its button, or above it when there's no room below. It follows the button as the page
  // scrolls, and closes once the button is scrolled out of sight.
  function placeRoles() {
    if (!roleMenu) return;
    var menu = roleMenu.el;
    var r = roleMenu.btn.getBoundingClientRect();
    if (r.bottom < 0 || r.top > window.innerHeight) { closeRoles(false); return; }
    var below = r.bottom + 6 + menu.offsetHeight < window.innerHeight;
    menu.style.top = (below ? r.bottom + 6 : Math.max(8, r.top - 6 - menu.offsetHeight)) + "px";
    menu.style.left = Math.max(8, Math.min(r.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8)) + "px";
  }
  document.addEventListener("scroll", placeRoles, true);
  window.addEventListener("resize", placeRoles);

  // ---------- An app's page ----------
  var page = document.querySelector("[data-app-page]");
  if (page) initAppPage(page);

  function initAppPage(page) {
    var S = JSON.parse(page.dataset.state);
    var $ = function (sel) { return document.querySelector(sel); };
    var $$ = function (sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); };
    var ICONS = {
      lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
      people: '<circle cx="9" cy="8" r="3.5"/><circle cx="17" cy="9" r="2.5"/><path d="M2 20c0-3.5 3-5.5 7-5.5s7 2 7 5.5M16 14.5c3 0 6 1.5 6 4.5"/>',
      globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z"/>'
    };
    var icon = function (name) {
      return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICONS[name] + "</svg>";
    };
    viewersCanWrite = function () { return S.dataWrites === "everyone"; };

    var name = function () { return S.title || S.fallbackName; };
    var unique = function (list) { return list.filter(function (x, i) { return list.indexOf(x) === i; }); };
    var without = function (list, email) { return list.filter(function (x) { return x !== email; }); };
    var sharedWith = function () { return without(unique(S.allowedEmails.concat(S.editors)), S.ownerEmail); };
    var roleOf = function (email) {
      return S.editors.indexOf(email) !== -1 ? (S.sharers.indexOf(email) !== -1 ? "admin" : "editor") : "viewer";
    };
    function access() {
      if (S.publicUrl) return { kind: "public", label: "Public", icon: "globe" };
      if (S.visibility === "all") return { kind: "members", label: "Formelab members", icon: "people" };
      var n = sharedWith().length;
      return n ? { kind: "shared", label: "Shared with " + n, icon: "people" } : { kind: "private", label: "Only you", icon: "lock" };
    }

    function patch(body) {
      return api("PATCH", "/sites/" + encodeURIComponent(S.id), body).then(function (v) {
        ["title", "publicUrl", "allowedEmails", "editors", "sharers", "visibility", "dataWrites", "guestResponses", "linkPreview", "sheets"].forEach(function (k) { S[k] = v[k]; });
        $("[data-updated]").textContent = "Updated just now";
        render();
        return v;
      });
    }
    // A failed save says why, and puts the page back the way it was.
    function failed(e) { toast(e.message, true); render(); }

    function render() {
      $$("[data-name-text]").forEach(function (el) { el.textContent = name(); });
      document.title = name() + " · Formelab";
      var title = $("[data-title]");
      if (document.activeElement !== title) title.value = S.title || "";
      var a = access();
      var pill = $("[data-pill]");
      pill.className = "sharepill " + a.kind;
      var accessBtn = pill.querySelector(".sp-access");
      accessBtn.innerHTML = icon(a.icon) + "<span></span>";
      accessBtn.querySelector("span").textContent = a.label;
      accessBtn.setAttribute("aria-label", a.label + ". Change who can open it");

      var isPublic = !!S.publicUrl;
      $$("[data-access-choice]").forEach(function (b) { b.setAttribute("aria-pressed", (b.dataset.accessChoice === "public") === isPublic ? "true" : "false"); });
      $("[data-invite-hint]").hidden = isPublic;
      $("[data-members-note]").hidden = isPublic || S.visibility !== "all";
      $("[data-public-warn]").hidden = !isPublic;
      $("[data-linkbox]").hidden = !isPublic;
      $("[data-public-url]").textContent = S.publicUrl || "";
      var guestRow = $("[data-guest-row]");
      if (guestRow) guestRow.hidden = !isPublic;
      $$("[data-setting]").forEach(function (box) {
        box.checked = box.dataset.setting === "dataWrites" ? S.dataWrites === "everyone" : !!S.guestResponses;
      });
      $$("[data-preview]").forEach(function (card) { card.hidden = card.dataset.preview !== S.linkPreview; });
      var lead = "This is what people see when the link is shared in iMessage, Slack or WhatsApp.";
      $("[data-preview-note]").textContent = S.linkPreview === "private"
        ? lead + " Because the app is invited only, it shows a private card and the app's name stays hidden."
        : lead + (isPublic ? " Because the link is public, it shows the app's name and picture." : " It shows the app's name and picture.");
      renderPeople();
    }

    function renderPeople() {
      var list = $("[data-people]");
      list.textContent = "";
      function row(email, sub, control, isOwnerRow) {
        var li = document.createElement("li");
        li.className = "person";
        li.innerHTML = '<span class="avatar' + (isOwnerRow ? "" : " soft") + '" aria-hidden="true"></span><span class="pi"><span class="pe"></span><span class="ps"></span></span>';
        li.querySelector(".avatar").textContent = email.slice(0, 1).toUpperCase();
        li.querySelector(".pe").textContent = email + (email === S.me ? " (you)" : "");
        li.querySelector(".ps").textContent = sub;
        li.appendChild(control);
        list.appendChild(li);
      }
      function label(text) {
        var span = document.createElement("span");
        span.className = "role-label";
        span.textContent = text;
        return span;
      }
      row(S.ownerEmail, "Owner", label("Owner"), true);
      sharedWith().forEach(function (email) {
        var role = roleOf(email);
        var note = personNote(email);
        // The owner changes every role; Admins only Viewers (only the owner may choose editors).
        var roles = email === S.me ? "" : S.isOwner ? "viewer,editor,admin" : S.canShare && role === "viewer" ? "viewer" : "";
        if (!roles) { row(email, note, label(ROLES[role][0])); return; }
        var b = document.createElement("button");
        b.type = "button";
        b.className = "rp-btn";
        b.dataset.person = email;
        b.dataset.role = role;
        b.dataset.roles = roles;
        b.setAttribute("aria-haspopup", "listbox");
        b.setAttribute("aria-expanded", "false");
        b.setAttribute("aria-label", "Role for " + email);
        b.innerHTML = "<span></span>" + CHEVRON;
        b.querySelector("span").textContent = ROLES[role][0];
        row(email, note, b);
        if (pendingRole(email)) list.lastChild.querySelector(".ps").classList.add("pending");
      });
    }

    var hasAccount = function (email) { return S.accounts.indexOf(email) !== -1; };
    var pendingRole = function (email) {
      var p = S.pending.filter(function (x) { return x.email === email; })[0];
      return p ? p.role : null;
    };
    function personNote(email) {
      var p = pendingRole(email);
      if (p) return "Sign-up invite sent. Becomes " + aRole(p) + " once they join Formelab.";
      return hasAccount(email) ? "Invited" : "Invited, no Formelab account yet";
    }

    // The lists that give `email` a role ("remove" takes them off all of them). Only the owner
    // may change editors, so Admins send the viewer list alone.
    function listsFor(email, role) {
      var allowed = without(S.allowedEmails, email);
      var editors = without(S.editors, email);
      var sharers = without(S.sharers, email);
      if (role === "viewer") allowed.push(email);
      if (role === "editor" || role === "admin") editors.push(email);
      if (role === "admin") sharers.push(email);
      var body = { allowed_emails: allowed };
      if (S.isOwner) { body.editors = editors; body.sharers = sharers; }
      return body;
    }
    var aRole = function (role) { return role === "viewer" ? "a Viewer" : role === "editor" ? "an Editor" : "an Admin"; };

    var refocus = function (email) {
      var again = document.querySelector('[data-person="' + CSS.escape(email) + '"]');
      if (again) again.focus();
    };
    var dropPending = function (emails) { S.pending = S.pending.filter(function (p) { return emails.indexOf(p.email) === -1; }); };
    function setRole(email, role) {
      if (role === "owner") { askTransfer(email); return; }
      // Editors and Admins sign in to make changes: someone without an account gets a sign-up invite.
      if ((role === "editor" || role === "admin") && !hasAccount(email)) { askSignup(email, role); return; }
      patch(listsFor(email, role)).then(function () {
        if (role !== "viewer") dropPending([email]);
        renderPeople();
        toast(role === "remove" ? email + " no longer has access" : email + " is now " + aRole(role));
        refocus(email);
      }, failed);
    }

    // Sign-up invites: they stay (or become) a Viewer now, and take the role when they join.
    function sendInvites(emails, role) {
      return api("POST", "/sites/" + encodeURIComponent(S.id) + "/invites", { emails: emails, role: role }).then(function (r) {
        ["allowedEmails", "editors", "sharers", "publicUrl", "visibility"].forEach(function (k) { S[k] = r.site[k]; });
        dropPending(emails);
        emails.forEach(function (x) { S.pending.push({ email: x, role: role }); });
        render();
        toast(r.note || (emails.length === 1 ? "Sign-up invite sent to " + emails[0] : "Sign-up invites sent to " + emails.length + " people"));
      });
    }
    function askSignup(email, role) {
      var d = $("#dlg-signup");
      d.querySelector("[data-signup-email]").textContent = email;
      d.querySelector("[data-signup-role]").textContent = ROLES[role][0];
      d.querySelector("[data-signup-a-role]").textContent = aRole(role);
      var go = d.querySelector("[data-signup-go]");
      go.onclick = function () {
        go.disabled = true;
        sendInvites([email], role).then(function () { d.close(); refocus(email); }, function (e) { toast(e.message, true); }).then(function () { go.disabled = false; });
      };
      d.showModal();
    }

    // Transfer ownership: only to an Admin with an account, after ticking the box.
    function askTransfer(email) {
      var d = $("#dlg-transfer");
      var ok = d.querySelector("[data-transfer-ok]");
      var go = d.querySelector("[data-transfer-go]");
      d.querySelector("[data-transfer-to]").textContent = email;
      ok.checked = false;
      go.disabled = true;
      ok.onchange = function () { go.disabled = !ok.checked; };
      go.onclick = function () {
        go.disabled = true;
        api("POST", "/sites/" + encodeURIComponent(S.id) + "/transfer", { to: email, confirm: true }).then(function () {
          d.close();
          flashNext(email + " now owns " + name() + ". It's under Shared with me.");
          location.reload();
        }, function (e) { go.disabled = !ok.checked; toast(e.message, true); });
      };
      d.showModal();
    }

    // Header: the name saves when you leave the field or press Enter; Esc puts it back.
    var title = $("[data-title]");
    title.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter") { ev.preventDefault(); title.blur(); }
      if (ev.key === "Escape") { title.value = S.title || ""; title.blur(); }
    });
    title.addEventListener("change", function () {
      var value = title.value.trim();
      if (value === (S.title || "")) return;
      patch({ title: value }).then(function () { toast("Name saved"); }, failed);
    });

    var star = $(".star-btn");
    paintStar(star, !!S.starred);
    star.addEventListener("click", function () {
      var on = !S.starred;
      S.starred = on;
      paintStar(star, on);
      saveStar(S.id, on).then(function () {
        toast(on ? "Starred. It shows at the top of your apps." : "Removed from starred");
      }, function (e) {
        S.starred = !on;
        paintStar(star, !on);
        toast(e.message, true);
      });
    });

    // Tabs: Sharing, Update, Activity. Arrow keys move between them; the address keeps the open one.
    var tabs = $$("[role=tab]");
    function selectTab(key, focus) {
      tabs.forEach(function (t) {
        var on = t.dataset.tab === key;
        t.setAttribute("aria-selected", on ? "true" : "false");
        t.tabIndex = on ? 0 : -1;
        document.getElementById(t.getAttribute("aria-controls")).hidden = !on;
        if (on && focus) t.focus();
      });
      try { history.replaceState(null, "", key === "sharing" ? location.pathname : "#" + key); } catch (e) {}
    }
    tabs.forEach(function (t, i) {
      t.addEventListener("click", function () { selectTab(t.dataset.tab); });
      t.addEventListener("keydown", function (ev) {
        var to = ev.key === "ArrowRight" ? (i + 1) % tabs.length : ev.key === "ArrowLeft" ? (i - 1 + tabs.length) % tabs.length : -1;
        if (to !== -1) { ev.preventDefault(); selectTab(tabs[to].dataset.tab, true); }
      });
    });
    var start = location.hash.slice(1);
    if (tabs.some(function (t) { return t.dataset.tab === start; })) selectTab(start);

    // The "..." menu.
    var menuBtn = $("[data-menu-btn]");
    var menu = $("#app-menu");
    function closeMenu(refocus) {
      if (menu.hidden) return;
      menu.hidden = true;
      menuBtn.setAttribute("aria-expanded", "false");
      if (refocus) menuBtn.focus();
    }
    menuBtn.addEventListener("click", function () {
      if (!menu.hidden) { closeMenu(); return; }
      menu.hidden = false;
      menuBtn.setAttribute("aria-expanded", "true");
      menu.querySelector("button").focus();
    });
    menu.addEventListener("keydown", function (ev) {
      var items = Array.prototype.slice.call(menu.querySelectorAll("button"));
      var i = items.indexOf(document.activeElement);
      if (ev.key === "ArrowDown") { ev.preventDefault(); items[(i + 1) % items.length].focus(); }
      if (ev.key === "ArrowUp") { ev.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
      if (ev.key === "Tab") closeMenu(false);
    });
    menu.addEventListener("click", function () { closeMenu(false); });
    document.addEventListener("click", function (ev) {
      if (!menu.hidden && !menu.contains(ev.target) && !menuBtn.contains(ev.target)) closeMenu(false);
    });
    document.addEventListener("keydown", function (ev) {
      if (ev.key !== "Escape") return;
      if (roleMenu) closeRoles(true);
      else closeMenu(true);
    });

    // Delete: type the app's name to confirm.
    var delInput = $("[data-delete-input]");
    if (delInput) {
      var delGo = $("[data-delete-go]");
      $("#dlg-delete").addEventListener("close", function () { delInput.value = ""; delGo.disabled = true; });
      delInput.addEventListener("input", function () { delGo.disabled = delInput.value.trim() !== name(); });
      delGo.addEventListener("click", function () {
        delGo.disabled = true;
        api("DELETE", "/sites/" + encodeURIComponent(S.id)).then(function () {
          $("#dlg-delete").close();
          toast(name() + " deleted");
          setTimeout(function () { location.href = S.next; }, 900);
        }, function (e) { delGo.disabled = false; toast(e.message, true); });
      });
    }

    $("[data-reset-go]").addEventListener("click", function () {
      $("#dlg-reset").close();
      patch({ public_link: "new" }).then(function () { toast("New link ready. The old one no longer works."); }, failed);
    });

    // The Connected apps tab: the app's spreadsheets and saved keys (connected_apps flag).
    var conns = $("[data-conns]");
    if (conns) initConnections();
    function initConnections() {
      var SHEET_LOGO = (conns.querySelector('[data-conn="sheets"] .conn-ic') || { innerHTML: "" }).innerHTML;
      function refresh() {
        var n = conns.querySelectorAll("[data-key], [data-conn]").length - (conns.querySelector('[data-conn="sheets"]') ? 1 : 0) + (S.sheets.length ? 1 : 0);
        var badge = $("[data-conn-count]");
        if (badge) badge.textContent = n;
        var any = conns.children.length > 0;
        $("[data-conn-empty]").hidden = any;
        $("[data-conn-intro]").hidden = !any;
      }
      function renderSheets() {
        var list = conns.querySelector("[data-sheet-list]");
        if (!list) return;
        list.textContent = "";
        S.sheets.forEach(function (id) {
          var li = document.createElement("li");
          li.className = "sheet-item";
          li.dataset.sheet = id;
          li.innerHTML = SHEET_LOGO + '<a target="_blank" rel="noopener"></a>' + (S.me === S.ownerEmail ? '<button type="button" class="secondary small">Remove</button>' : "");
          var a = li.querySelector("a");
          a.href = "https://docs.google.com/spreadsheets/d/" + encodeURIComponent(id);
          a.textContent = "Spreadsheet " + id.slice(-6);
          var rm = li.querySelector("button");
          if (rm) rm.dataset.sheetRemove = id;
          list.appendChild(li);
        });
        conns.querySelector("[data-sheet-empty]").hidden = S.sheets.length > 0;
        refresh();
      }
      var addForm = conns.querySelector("[data-sheet-add]");
      var addOpen = conns.querySelector("[data-sheet-add-open]");
      if (addForm) {
        addOpen.addEventListener("click", function () {
          addForm.hidden = !addForm.hidden;
          addOpen.setAttribute("aria-expanded", addForm.hidden ? "false" : "true");
          if (!addForm.hidden) addForm.elements.sheet.focus();
        });
        addForm.addEventListener("submit", function (ev) {
          ev.preventDefault();
          var link = addForm.elements.sheet.value.trim();
          if (!/docs\.google\.com\/spreadsheets\/d\/[\w-]+|^[\w-]{20,}$/.test(link)) { toast("That doesn't look like a Google Sheets link. Copy it from the spreadsheet's address bar.", true); return; }
          busy(addForm, true);
          patch({ sheets: S.sheets.concat([link]) }).then(function () {
            addForm.reset();
            addForm.hidden = true;
            addOpen.setAttribute("aria-expanded", "false");
            renderSheets();
            toast("Spreadsheet added. This app can read and add rows to it.");
          }, failed).then(function () { busy(addForm, false); });
        });
      }
      var removing = null;
      var keyDialog = $("#dlg-key-remove");
      conns.addEventListener("click", function (ev) {
        var rmSheet = ev.target.closest("[data-sheet-remove]");
        if (rmSheet) {
          var id = rmSheet.dataset.sheetRemove;
          patch({ sheets: S.sheets.filter(function (x) { return x !== id; }) }).then(function () {
            // Its last spreadsheet: the app isn't connected to Google Sheets any more.
            if (!S.sheets.length) {
              flashNext("Spreadsheet removed. This app doesn't use Google Sheets any more.");
              location.reload();
              return;
            }
            renderSheets();
            toast("Spreadsheet removed. This app can't reach it any more.");
          }, failed);
          return;
        }
        var rmConn = ev.target.closest("[data-conn-remove]");
        if (rmConn) {
          var cname = rmConn.dataset.connRemove;
          var clabel = rmConn.closest(".conn").querySelector("strong").firstChild.textContent.trim();
          if (!confirm("Stop " + name() + " using " + clabel + "? To use it again, ask your AI to add it back.")) return;
          rmConn.disabled = true;
          api("DELETE", "/sites/" + encodeURIComponent(S.id) + "/connectors/" + encodeURIComponent(cname)).then(function () {
            rmConn.closest(".conn").remove();
            refresh();
            toast(clabel + " removed from this app");
          }, function (e) { rmConn.disabled = false; toast(e.message, true); });
          return;
        }
        var row = ev.target.closest("[data-key]");
        if (!row) return;
        var form = row.querySelector("[data-key-form]");
        if (ev.target.closest("[data-key-replace]")) { form.hidden = false; form.elements.value.focus(); return; }
        if (ev.target.closest("[data-key-cancel]")) { form.reset(); form.hidden = true; row.querySelector("[data-key-replace]").focus(); return; }
        if (ev.target.closest("[data-key-remove]")) {
          removing = row;
          keyDialog.querySelector("[data-key-remove-name]").textContent = row.dataset.key;
          keyDialog.showModal();
        }
      });
      conns.addEventListener("submit", function (ev) {
        var form = ev.target.closest("[data-key-form]");
        if (!form) return;
        ev.preventDefault();
        var name = form.closest("[data-key]").dataset.key;
        var value = form.elements.value.value;
        if (!value.trim()) { toast("Paste the new key first.", true); form.elements.value.focus(); return; }
        busy(form, true);
        api("PUT", "/sites/" + encodeURIComponent(S.id) + "/keys/" + encodeURIComponent(name), { value: value }).then(function () {
          form.reset();
          form.hidden = true;
          toast("Key replaced. " + name + " uses the new one from now on.");
        }, function (e) { toast(e.message, true); }).then(function () { busy(form, false); });
      });
      if (keyDialog) {
        keyDialog.querySelector("[data-key-remove-go]").addEventListener("click", function () {
          if (!removing) return;
          var row = removing;
          var name = row.dataset.key;
          api("DELETE", "/sites/" + encodeURIComponent(S.id) + "/keys/" + encodeURIComponent(name)).then(function () {
            keyDialog.close();
            row.remove();
            removing = null;
            refresh();
            toast(name + " removed");
          }, function (e) { toast(e.message, true); });
        });
      }
    }

    var copyBtn = $("[data-copy-app]");
    if (copyBtn) {
      copyBtn.addEventListener("click", function () {
        copyBtn.disabled = true;
        toast("Making a copy…");
        api("POST", "/sites/" + encodeURIComponent(S.id) + "/copy").then(function (r) {
          flashNext("Made a copy: " + (r.site.title || r.site.mountPath) + ". Only you can open it.");
          location.href = "/apps/" + encodeURIComponent(r.site.id);
        }, function (e) { copyBtn.disabled = false; toast(e.message, true); });
      });
    }

    page.addEventListener("click", function (ev) {
      var t = ev.target;
      if (t.closest("[data-goto-tab]")) {
        selectTab(t.closest("[data-goto-tab]").dataset.gotoTab, true);
        document.getElementById("panel-sharing").scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }
      if (t.closest("[data-copy-link]")) {
        copyText(S.publicUrl || S.url, copiedMessage(access().kind, sharedWith().length));
        return;
      }
      if (t.closest("[data-copy-public]")) { copyText(S.publicUrl, "Link copied"); return; }
      var choice = t.closest("[data-access-choice]");
      if (choice) {
        var toPublic = choice.dataset.accessChoice === "public";
        if (toPublic === !!S.publicUrl) return;
        // Previews always follow who can open the app now; Invited only also ends "all members".
        var body = toPublic ? { public_link: true, link_preview: "auto" } : { public_link: false, visibility: "restricted", link_preview: "auto" };
        patch(body).then(function () {
          toast(toPublic ? "Anyone with the link can open it now" : "Only people you invite can open it now");
        }, failed);
        return;
      }
      if (t.closest("[data-limit]")) {
        patch({ visibility: "restricted", link_preview: "auto" }).then(function () { toast("Only people you invite can open it now"); }, failed);
        return;
      }
      var person = t.closest("[data-person]");
      if (person) {
        var email = person.dataset.person;
        var canOwn = roleOf(email) === "admin" && hasAccount(email) && !pendingRole(email);
        openRoles(person, function (role) { setRole(email, role); }, true, S.isOwner ? canOwn : null);
        return;
      }
      var inviteRole = t.closest("[data-invite-role]");
      if (inviteRole) {
        openRoles(inviteRole, function (role) {
          inviteRole.dataset.role = role;
          inviteRole.querySelector("span").textContent = ROLES[role][0];
        }, false);
      }
    });
    // Open a role picker from the keyboard with the arrow keys too.
    page.addEventListener("keydown", function (ev) {
      var btn = ev.target.closest && ev.target.closest(".rp-btn");
      if (btn && (ev.key === "ArrowDown" || ev.key === "ArrowUp")) { ev.preventDefault(); btn.click(); }
    });

    page.addEventListener("change", function (ev) {
      var box = ev.target.closest("[data-setting]");
      if (!box) return;
      var on = box.checked;
      var body = box.dataset.setting === "dataWrites" ? { data_writes: on ? "everyone" : "editors" } : { guest_responses: on };
      patch(body).then(function () {
        toast(box.dataset.setting === "dataWrites"
          ? on ? "Viewers can change the app's data now" : "Only you, Editors and Admins can change its data now"
          : on ? "Anyone with the link can send answers now" : "People with the link can no longer send answers");
      }, failed);
    });

    // The note under the invite row for people who need an account to become an Editor or Admin.
    var acctNote = $("[data-acct-note]");
    function hideAcctNote() { acctNote.hidden = true; acctNote.textContent = ""; }
    function showAcctNote(emails, role) {
      var one = emails.length === 1;
      acctNote.innerHTML = '<p><strong></strong> <span></span></p><div class="acct-actions"><button type="button" data-an="signup"></button><button type="button" class="secondary" data-an="viewer">Add as Viewer instead</button><button type="button" class="secondary" data-an="cancel">Cancel</button></div>';
      acctNote.querySelector("strong").textContent = emails.join(", ");
      acctNote.querySelector("span").textContent = (one ? "doesn't" : "don't") + " have a Formelab account yet. " + ROLES[role][0] + "s need one, since they sign in to make changes.";
      acctNote.querySelector('[data-an="signup"]').textContent = one ? "Send a sign-up invite" : "Send sign-up invites";
      acctNote.hidden = false;
      var input = invite.elements.emails;
      acctNote.onclick = function (ev) {
        var b = ev.target.closest("[data-an]");
        if (!b) return;
        var which = b.dataset.an;
        if (which === "cancel") { hideAcctNote(); input.value = ""; input.focus(); return; }
        b.disabled = true;
        var done = which === "signup"
          ? sendInvites(emails, role)
          : patch({ allowed_emails: unique(S.allowedEmails.concat(emails)) }).then(function () { toast(one ? emails[0] + " added as a Viewer" : "Added " + emails.length + " people as Viewers"); });
        done.then(function () { hideAcctNote(); input.value = ""; }, function (e) { b.disabled = false; toast(e.message, true); });
      };
      acctNote.querySelector('[data-an="signup"]').focus();
    }

    var invite = $("[data-invite]");
    if (invite) {
      invite.addEventListener("submit", function (ev) {
        ev.preventDefault();
        var input = invite.elements.emails;
        var raw = input.value.split(/[\s,;]+/).map(function (x) { return x.trim().toLowerCase(); }).filter(Boolean);
        if (!raw.length) { toast("Add an email first", true); input.focus(); return; }
        var bad = raw.filter(function (x) { return !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x); });
        if (bad.length) { toast("Check this email address: " + bad[0], true); input.focus(); return; }
        var current = sharedWith().concat([S.ownerEmail]);
        var fresh = unique(raw).filter(function (x) { return current.indexOf(x) === -1; });
        if (!fresh.length) { toast(raw.length === 1 ? raw[0] + " already has access" : "They all have access already", true); return; }
        var role = invite.querySelector("[data-invite-role]").dataset.role;
        hideAcctNote();
        busy(invite, true);
        api("POST", "/sites/" + encodeURIComponent(S.id) + "/people/check", { emails: fresh }).then(function (r) {
          var without = r.withoutAccount;
          fresh.forEach(function (x) { if (without.indexOf(x) === -1 && !hasAccount(x)) S.accounts.push(x); });
          // Viewers don't need an account. Editors and Admins do: the rest get the note below.
          var now = role === "viewer" ? fresh : fresh.filter(function (x) { return without.indexOf(x) === -1; });
          var later = role === "viewer" ? [] : without;
          var body = {};
          if (role === "viewer") body.allowed_emails = unique(S.allowedEmails.concat(now));
          else {
            body.editors = unique(S.editors.concat(now));
            body.sharers = role === "admin" ? unique(S.sharers.concat(now)) : S.sharers;
            body.allowed_emails = S.allowedEmails.filter(function (x) { return now.indexOf(x) === -1; });
          }
          var saved = now.length ? patch(body) : Promise.resolve(null);
          return saved.then(function (res) {
            input.value = later.join(", ");
            if (later.length) showAcctNote(later, role);
            // Over the daily share email limit: say who wasn't emailed.
            if (now.length) toast(res && res.note ? res.note : now.length === 1 ? "Invited " + now[0] + " as " + aRole(role) : "Invited " + now.length + " people as " + ROLES[role][0] + "s");
          });
        }).catch(failed).then(function () { busy(invite, false); });
      });
    }

    // Update: describe a change and your AI rewrites the app; progress in plain words.
    var prompt = $("[data-update-prompt]");
    page.addEventListener("click", function (ev) {
      var idea = ev.target.closest("[data-append-idea]");
      if (idea && prompt) {
        var text = prompt.value.trim().replace(/[.\s]+$/, "");
        prompt.value = text ? text + ". " + idea.dataset.appendIdea : idea.dataset.appendIdea;
        prompt.focus();
        return;
      }
      var go = ev.target.closest("[data-update]");
      if (go) runUpdate(go);
      var showUpload = ev.target.closest("[data-show-upload]");
      if (showUpload) {
        var zone = $("[data-dropzone]");
        zone.hidden = !zone.hidden;
        showUpload.setAttribute("aria-expanded", zone.hidden ? "false" : "true");
      }
    });

    var STAGES = ["Reading your app…", "Sketching the changes…", "Wiring it up…", "Almost there…"];
    function runUpdate(btn) {
      var change = prompt.value.trim();
      if (!change) { toast("Tell it what to change first", true); prompt.focus(); return; }
      var box = $("[data-progress]");
      var text = $("[data-progress-text]");
      var started = Date.now();
      var chars = 0;
      var stage = -1;
      function step() {
        // Words for how far along it is, from how much it has written and how long it's taken.
        var s = Math.max(chars > 12000 ? 3 : chars > 4000 ? 2 : chars > 0 ? 1 : 0, Math.min(3, Math.floor((Date.now() - started) / 20000)));
        if (s > stage) { stage = s; text.textContent = STAGES[s]; }
      }
      btn.disabled = true;
      box.className = "progress";
      box.hidden = false;
      step();
      var timer = setInterval(step, 1000);
      var finished = false;
      function finish(ok, message) {
        if (finished) return;
        finished = true;
        clearInterval(timer);
        btn.disabled = false;
        box.className = "progress " + (ok ? "done" : "error");
        if (ok) {
          text.innerHTML = "It's live. <a target=\"_blank\" rel=\"noopener\">Take a look</a>";
          text.querySelector("a").href = S.url;
          prompt.value = "";
          $("[data-updated]").textContent = "Updated just now";
        } else {
          text.textContent = message;
          toast(message, true);
        }
      }
      function handle(line) {
        if (!line.trim()) return;
        var msg;
        try { msg = JSON.parse(line); } catch (e) { return; }
        if (msg.error) finish(false, msg.error.message + (msg.error.hint ? " " + msg.error.hint : ""));
        else if (msg.done) finish(true);
        else if (msg.progress) { chars = msg.progress; step(); }
      }
      fetch("/_api/admin/build", {
        method: "POST",
        credentials: "same-origin",
        headers: { "x-formelab-request": "1", "content-type": "application/json" },
        body: JSON.stringify({ provider: btn.dataset.update, site_id: S.id, change: change })
      }).then(function (res) {
        if (!res.ok || !res.body) {
          return res.json().then(function (d) { throw new Error(d.error.message + (d.error.hint ? " " + d.error.hint : "")); }, function () { throw new Error("Request failed (" + res.status + ")"); });
        }
        var reader = res.body.getReader();
        var decoder = new TextDecoder();
        var buf = "";
        function pump() {
          return reader.read().then(function (r) {
            if (r.done) { handle(buf); finish(false, "The update stopped before it finished. Check the app in a minute, or try again."); return; }
            buf += decoder.decode(r.value, { stream: true });
            var lines = buf.split("\n");
            buf = lines.pop();
            lines.forEach(handle);
            return pump();
          });
        }
        return pump();
      }).catch(function (e) { finish(false, e.message || "The update failed. Try again."); });
    }

    // Upload a new version: drop a file on the box, or choose one.
    var zone = $("[data-dropzone]");
    var fileInput = $("[data-upload-file]");
    function upload(file) {
      if (!file) return;
      if (!/\.(html?|zip)$/i.test(file.name)) { toast("Choose an .html or .zip file", true); return; }
      var fd = new FormData();
      fd.set("file", file);
      fd.set("namespace", S.namespace);
      fd.set("mount_path", S.mountPath);
      zone.classList.add("busy");
      api("POST", "/sites", fd).then(function () {
        toast("New version published");
        $("[data-updated]").textContent = "Updated just now";
      }, function (e) { toast(e.message, true); }).then(function () {
        zone.classList.remove("busy");
        fileInput.value = "";
      });
    }
    fileInput.addEventListener("change", function () { upload(fileInput.files[0]); });
    zone.addEventListener("dragover", function (ev) { ev.preventDefault(); zone.classList.add("over"); });
    zone.addEventListener("dragleave", function () { zone.classList.remove("over"); });
    zone.addEventListener("drop", function (ev) {
      ev.preventDefault();
      zone.classList.remove("over");
      upload(ev.dataTransfer.files[0]);
    });

    render();
  }

  // ---------- A test plan in the admin panel: a result for each case ----------
  var tpPage = document.querySelector("[data-test-plan]");
  if (tpPage) initTestPlan(tpPage);

  function initTestPlan(root) {
    var slug = root.dataset.testPlan;
    var rows = Array.prototype.slice.call(root.querySelectorAll("tr[data-case]"));
    var results = {};
    var filter = "all";
    rows.forEach(function (tr) {
      var on = tr.querySelector('[data-result][aria-pressed="true"]');
      var note = tr.querySelector(".tp-note");
      if (on) results[tr.dataset.case] = { status: on.dataset.result, notes: note ? note.textContent : "" };
    });

    function render() {
      var n = { pass: 0, fail: 0, blocked: 0, todo: 0 };
      rows.forEach(function (tr) {
        var r = results[tr.dataset.case];
        var s = r ? r.status : "todo";
        n[s]++;
        tr.dataset.status = s;
        tr.querySelectorAll("[data-result]").forEach(function (b) { b.setAttribute("aria-pressed", r && r.status === b.dataset.result ? "true" : "false"); });
        var td = tr.querySelector("td.res");
        if (!td.querySelector("textarea")) {
          var note = td.querySelector(".tp-note");
          if (r && r.notes) {
            if (!note) { note = document.createElement("div"); note.className = "tp-note"; td.insertBefore(note, td.querySelector("[data-note]")); }
            note.textContent = r.notes;
          } else if (note) note.remove();
          td.querySelector("[data-note]").textContent = r && r.notes ? "Edit note" : "Add note";
        }
        tr.hidden = filter !== "all" && filter !== s;
      });
      n.all = rows.length;
      root.querySelectorAll("[data-tp-count]").forEach(function (b) { b.textContent = n[b.dataset.tpCount]; });
      var bar = root.querySelector("[data-tp-bar]");
      ["pass", "fail", "blocked"].forEach(function (s) { bar.querySelector("." + s).style.width = (rows.length ? (n[s] / rows.length) * 100 : 0) + "%"; });
      bar.setAttribute("aria-label", n.pass + " passed, " + n.fail + " failed, " + n.blocked + " blocked, " + n.todo + " not run");
      // With a filter on, hide the case tables (and their section headings) left with no rows.
      root.querySelectorAll(".tp-table.has-cases").forEach(function (t) { t.hidden = !t.querySelector("tr[data-case]:not([hidden])"); });
      root.querySelector(".tp-doc").classList.toggle("filtered", filter !== "all");
      root.querySelectorAll(".tp-doc h2").forEach(function (h) {
        var el = h.nextElementSibling, any = false;
        while (el && el.tagName !== "H2") { if (el.classList.contains("has-cases") && !el.hidden) any = true; el = el.nextElementSibling; }
        h.classList.toggle("tp-empty", filter !== "all" && !any);
      });
    }

    function save(cases, source) {
      return api("PUT", "/test-plans/" + encodeURIComponent(slug) + "/results", { cases: cases, source: source || "page" }).then(function (r) {
        results = {};
        Object.keys(r.results).forEach(function (id) { results[id] = { status: r.results[id].status, notes: r.results[id].notes }; });
        render();
        return r;
      }, function (e) { toast(e.message, true); render(); throw e; });
    }

    root.addEventListener("click", function (ev) {
      var b = ev.target.closest("[data-result]");
      if (b) {
        var id = b.closest("tr").dataset.case;
        var prev = results[id];
        // Clicking the chosen result again clears it.
        var status = prev && prev.status === b.dataset.result ? "" : b.dataset.result;
        var c = {}; c[id] = { status: status, notes: prev ? prev.notes : "" };
        save(c).then(function () { toast(status ? id + ": " + b.textContent : id + " cleared"); }, function () {});
        return;
      }
      var nb = ev.target.closest("[data-note]");
      if (nb) {
        var tr = nb.closest("tr");
        var cid = tr.dataset.case;
        if (!results[cid]) { toast("Pick Pass, Fail or Blocked first, then add a note.", true); return; }
        var td = nb.closest("td");
        var old = td.querySelector(".tp-note");
        if (old) old.remove();
        nb.hidden = true;
        var ta = document.createElement("textarea");
        ta.className = "tp-note-edit";
        ta.rows = 3;
        ta.maxLength = 2000;
        ta.setAttribute("aria-label", "Note for " + cid);
        ta.value = results[cid].notes || "";
        td.appendChild(ta);
        ta.focus();
        var done = false;
        var finish = function (keep) {
          if (done) return;
          done = true;
          var notes = ta.value.trim();
          ta.remove();
          nb.hidden = false;
          if (!keep || notes === (results[cid].notes || "")) { render(); return; }
          var c2 = {}; c2[cid] = { status: results[cid].status, notes: notes };
          save(c2).then(function () { toast("Note saved on " + cid); }, function () {});
        };
        ta.addEventListener("blur", function () { finish(true); });
        ta.addEventListener("keydown", function (k) { if (k.key === "Escape") { k.preventDefault(); finish(false); nb.focus(); } });
        return;
      }
      var f = ev.target.closest("[data-tp-filter]");
      if (f) {
        filter = f.dataset.tpFilter;
        root.querySelectorAll("[data-tp-filter]").forEach(function (x) { x.setAttribute("aria-pressed", x === f ? "true" : "false"); });
        render();
        return;
      }
      var t = ev.target.closest("[data-tp-toggle]");
      if (t) {
        var panel = document.getElementById(t.dataset.tpToggle);
        var open = panel.hidden;
        root.querySelectorAll(".tp-panel").forEach(function (p) { p.hidden = true; });
        root.querySelectorAll("[aria-controls]").forEach(function (x) { if (x.dataset.tpToggle) x.setAttribute("aria-expanded", "false"); });
        panel.hidden = !open;
        var opener = root.querySelector('[aria-controls="' + panel.id + '"]');
        if (opener) opener.setAttribute("aria-expanded", open ? "true" : "false");
        if (open) { var field = panel.querySelector("textarea, button"); if (field) field.focus(); } else if (opener) opener.focus();
        return;
      }
      if (ev.target.closest("[data-tp-import]")) {
        var known = {};
        rows.forEach(function (r) { known[r.dataset.case] = true; });
        var cases = {}, count = 0, skipped = 0;
        document.getElementById("tp-import-text").value.split("\n").forEach(function (line) {
          var m = line.replace(/^[\s*-]+/, "").match(/^\[?([A-Za-z]{2}-\d{2})\]?\s*[|:,\t]\s*(pass(?:ed)?|fail(?:ed)?|blocked)\b\s*(?:[|:,\t-]\s*(.*))?$/i);
          if (!m || !known[m[1].toUpperCase()]) { if (line.trim()) skipped++; return; }
          var status = m[2].toLowerCase();
          status = status.indexOf("pass") === 0 ? "pass" : status.indexOf("fail") === 0 ? "fail" : "blocked";
          cases[m[1].toUpperCase()] = { status: status, notes: (m[3] || "").trim() };
          count++;
        });
        if (!count) { toast("No results found. Use one line per case, like MA-04 | fail | what happened.", true); return; }
        save(cases, "import").then(function () {
          document.getElementById("tp-import-text").value = "";
          document.getElementById("tp-import").hidden = true;
          toast("Saved " + count + " result" + (count === 1 ? "" : "s") + (skipped ? ", skipped " + skipped + " line" + (skipped === 1 ? "" : "s") : ""));
        }, function () {});
        return;
      }
      if (ev.target.closest("[data-tp-clear]")) {
        api("DELETE", "/test-plans/" + encodeURIComponent(slug) + "/results").then(function () {
          results = {};
          document.getElementById("tp-clear").hidden = true;
          render();
          toast("Results cleared. Ready for a new run.");
        }, function (e) { toast(e.message, true); });
        return;
      }
      if (ev.target.closest("[data-tp-copy]")) {
        var text = [
          "You're testing a Formelab change in a real browser. Work through the test plan below and report every case.",
          "",
          "When you finish, reply with one line per case in exactly this format, so the results can be pasted into the plan's Import results box:",
          "ID | pass | optional note",
          "ID | fail | what happened instead, with the browser and screen size",
          "ID | blocked | what's missing",
          "Put your summary and the detailed failure reports after those lines.",
          "",
          "If you're working in a browser signed in to the Formelab admin panel as an admin, you can also record each result directly on the plan's page: " + location.origin + location.pathname,
          "",
          "---",
          "",
          document.getElementById("tp-markdown").value
        ].join("\n");
        copyText(text, "Copied the plan and how to report back. Paste it into Claude.");
      }
    });
    render();
  }
})();
