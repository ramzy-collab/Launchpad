// Formelab's service worker, served at /sw.js on the web app host. It makes Formelab installable
// as an app and shows a page instead of the browser's error when there's no connection. It
// caches nothing: every page still comes from the network, so nobody sees stale data.
"use strict";

var OFFLINE = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Offline · Formelab</title>' +
  "<style>body{margin:0;min-height:100vh;display:grid;place-content:center;justify-items:center;gap:12px;padding:24px;text-align:center;font-family:Inter,system-ui,-apple-system,sans-serif;background:#FBFAF7;color:#1C1B19}" +
  "@media (prefers-color-scheme:dark){body{background:#161514;color:#F3F1EC}}" +
  ".m{width:56px;height:56px;border-radius:17px;background:#5B4CF5;transform:rotate(-6deg)}h1{margin:12px 0 0;font-size:22px}p{margin:0;opacity:.7}" +
  "button{margin-top:8px;background:#5B4CF5;color:#fff;border:0;border-radius:999px;padding:12px 22px;font:inherit;font-weight:600;cursor:pointer}</style></head>" +
  '<body><div class="m"></div><h1>You\'re offline</h1><p>Formelab needs a connection. Check yours, then try again.</p><button onclick="location.reload()">Try again</button></body></html>';

self.addEventListener("install", function () {
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", function (event) {
  if (event.request.mode !== "navigate") return;
  event.respondWith(
    fetch(event.request).catch(function () {
      return new Response(OFFLINE, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    })
  );
});
