// Consent page: send the form once. A second submit (double-click, impatient re-click) would
// reuse the one-time handle and show an error even though the first one already connected.
(function () {
  "use strict";
  var sent = false;
  document.addEventListener("submit", function (ev) {
    if (sent) {
      ev.preventDefault();
      return;
    }
    sent = true;
    // Don't set `disabled`: a disabled submitter would drop its name/value from the form data.
    var buttons = document.querySelectorAll("button");
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].classList.add("busy");
      buttons[i].setAttribute("aria-disabled", "true");
    }
  });
})();
