// Home page: waitlist sign-up, confirmation screen and sharing.
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var form = $("wait-form");
  if (!form) return;
  var field = $("field"), email = $("email"), msg = $("msg"), btn = $("join-btn");
  var DEFAULT_MSG = msg.textContent;
  var isEmail = function (v) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v); };

  function setError(text) {
    field.classList.add("err");
    msg.classList.add("err");
    msg.textContent = text;
    email.focus();
  }

  function setLoading(on) {
    btn.disabled = on;
    btn.classList.toggle("loading", on);
    btn.querySelector(".lbl").textContent = on ? "Saving your spot..." : "Save my spot";
  }

  function show(id) {
    $("landing").hidden = id !== "landing";
    $("confirm").hidden = id !== "confirm";
    window.scrollTo(0, 0);
  }

  email.addEventListener("input", function () {
    field.classList.remove("err");
    msg.classList.remove("err");
    msg.textContent = DEFAULT_MSG;
  });

  form.addEventListener("submit", function (ev) {
    ev.preventDefault();
    var value = email.value.trim();
    if (!isEmail(value)) {
      setError(value ? "Hmm, that email looks a little off. Mind checking it?" : "Pop your email in and we'll save you a spot.");
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
        confetti();
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

  function confetti() {
    if (window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    var box = document.createElement("div");
    box.className = "confetti";
    for (var i = 0; i < 60; i++) {
      var p = document.createElement("i");
      p.style.left = Math.random() * 100 + "vw";
      p.style.animationDelay = Math.random() * 0.35 + "s";
      p.style.transform = "rotate(" + Math.random() * 360 + "deg)";
      box.appendChild(p);
    }
    document.body.appendChild(box);
    setTimeout(function () { box.remove(); }, 2000);
  }
})();
