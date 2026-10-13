// Login pages: a loading screen from the moment someone signs in until the next page arrives.
// Served as a file so the page can use a strict CSP. The splash's styles are in home.css.
(function () {
  "use strict";

  function splash(text) {
    var el = document.getElementById("splash");
    if (!el) {
      el = document.createElement("div");
      el.id = "splash";
      el.className = "splash";
      el.setAttribute("role", "status");
      el.innerHTML = '<span class="splash-mark" aria-hidden="true">F</span><p class="splash-text"></p><span class="splash-bar" aria-hidden="true"></span>';
      document.body.appendChild(el);
    }
    el.querySelector(".splash-text").textContent = text;
    // Next frame, so the fade-in runs.
    requestAnimationFrame(function () { el.classList.add("on"); });
  }

  document.addEventListener("submit", function (ev) {
    var form = ev.target;
    if (!form.classList.contains("signin") || ev.defaultPrevented) return;
    var action = ev.submitter && ev.submitter.value;
    // Only the steps that sign someone in; asking for a code or a reset link answers quickly.
    if (form.getAttribute("action") === "/login/code" || action === "password") splash("Logging you in…");
  });

  document.addEventListener("click", function (ev) {
    if (ev.target.closest && ev.target.closest("a.provider")) splash("Taking you to Google…");
  });

  // Back to this page from the browser's history: no splash.
  window.addEventListener("pageshow", function (ev) {
    var el = document.getElementById("splash");
    if (ev.persisted && el) el.classList.remove("on");
  });
})();
