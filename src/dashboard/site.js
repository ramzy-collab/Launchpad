// Home page: waitlist sign-up, confirmation screen and sharing.
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var form = $("wait-form");
  if (!form) return;
  var email = $("email"), msg = $("msg"), btn = $("join-btn");
  var DEFAULT_MSG = msg.textContent;
  var isEmail = function (v) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v); };

  function setError(text) {
    email.classList.add("err");
    msg.classList.add("err");
    msg.textContent = text;
    email.focus();
  }

  function setLoading(on) {
    btn.disabled = on;
    btn.classList.toggle("loading", on);
    btn.querySelector(".lbl").textContent = on ? "Saving your spot..." : "Join the waitlist";
  }

  function show(id) {
    $("landing").hidden = id !== "landing";
    $("confirm").hidden = id !== "confirm";
    window.scrollTo(0, 0);
  }

  function toJoin() {
    show("landing");
    $("signup").scrollIntoView({ behavior: "smooth", block: "center" });
    setTimeout(function () { email.focus({ preventScroll: true }); }, 450);
  }

  // The nav's "Join the waitlist" scrolls to the form and focuses it.
  document.addEventListener("click", function (ev) {
    if (!ev.target.closest("[data-join]")) return;
    ev.preventDefault();
    toJoin();
  });
  if (location.hash === "#signup") setTimeout(toJoin, 50);

  email.addEventListener("input", function () {
    email.classList.remove("err");
    msg.classList.remove("err");
    msg.textContent = DEFAULT_MSG;
  });

  form.addEventListener("submit", function (ev) {
    ev.preventDefault();
    var value = email.value.trim();
    if (!isEmail(value)) {
      setError(value ? "That email looks a little off. Mind checking it?" : "Add your email to save a spot.");
      return;
    }
    setLoading(true);
    fetch("/_api/waitlist", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: value })
    })
      .then(function (res) {
        return res.json().catch(function () { return null; }).then(function (data) {
          if (!res.ok) {
            var e = data && data.error;
            throw new Error((e && (e.hint || e.message)) || "Something went wrong. Try again in a moment.");
          }
        });
      })
      .then(function () {
        $("conf-email").textContent = value;
        $("share-msg").textContent = "";
        email.value = "";
        show("confirm");
      })
      .catch(function (e) {
        setError(e && e.message ? e.message : "We couldn't reach Formelab. Check your connection and try again.");
      })
      .then(function () { setLoading(false); });
  });

  $("back-home").addEventListener("click", function () { show("landing"); });

  $("share").addEventListener("click", function () {
    var url = location.origin + "/";
    if (navigator.share) {
      navigator.share({ title: "Formelab", text: "SaaS is dead. Make your own.", url: url }).catch(function () {});
      return;
    }
    var out = $("share-msg");
    if (!navigator.clipboard) { out.textContent = url; return; }
    navigator.clipboard.writeText(url).then(
      function () { out.textContent = "Link copied. Go show someone."; },
      function () { out.textContent = url; }
    );
  });
})();
