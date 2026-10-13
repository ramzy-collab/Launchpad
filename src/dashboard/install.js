// Installing Formelab as an app (web app pages). Registers the service worker, turns on the
// Install buttons ([data-install]) when the browser offers to install, and marks which device
// this is so the Get the app page opens the right steps.
(function () {
  "use strict";
  var root = document.documentElement;
  var prompt = null;

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("/sw.js").catch(function () {});
    });
  }

  function installed() {
    return navigator.standalone === true || (window.matchMedia && matchMedia("(display-mode: standalone), (display-mode: window-controls-overlay), (display-mode: minimal-ui)").matches);
  }

  // ios, android, mac, desktop (Chrome, Edge, Firefox on a computer).
  function platform() {
    var ua = navigator.userAgent;
    if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return "ios";
    if (/Android/.test(ua)) return "android";
    if (/Macintosh/.test(ua) && /Safari\//.test(ua) && !/Chrome\/|Chromium\/|Edg\/|Firefox\//.test(ua)) return "mac";
    return "desktop";
  }

  function update() {
    root.setAttribute("data-installed", installed() ? "yes" : "no");
    root.setAttribute("data-can-install", prompt ? "yes" : "no");
    var buttons = document.querySelectorAll("[data-install]");
    for (var i = 0; i < buttons.length; i++) buttons[i].hidden = !prompt || installed();
  }

  root.setAttribute("data-platform", platform());
  update();

  window.addEventListener("beforeinstallprompt", function (ev) {
    ev.preventDefault();
    prompt = ev;
    update();
  });
  window.addEventListener("appinstalled", function () {
    prompt = null;
    update();
  });

  document.addEventListener("click", function (ev) {
    var button = ev.target.closest("[data-install]");
    if (!button || !prompt) return;
    var p = prompt;
    prompt = null;
    p.prompt();
    p.userChoice.then(update, update);
  });

  document.addEventListener("DOMContentLoaded", function () {
    update();
    // On Get the app, open the steps for this device.
    var steps = document.querySelector('details[data-steps="' + platform() + '"]');
    if (steps) steps.open = true;
  });
})();
