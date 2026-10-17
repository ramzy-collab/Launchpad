// Metrics page (admin panel): crosshair and tooltips for the server-drawn charts. Each plot carries
// its numbers in data-chart; pointer and arrow keys both move the readout. Labels go in with
// textContent only.
(function () {
  "use strict";

  function format(v, kind) {
    if (kind === "pct") return Math.round(v * 100) + "%";
    var a = Math.abs(v);
    var one = function (n) { return String(Math.round(n * 10) / 10); };
    if (a >= 1e6) return one(v / 1e6) + "M";
    if (a >= 1e4) return one(v / 1e3) + "K";
    if (a >= 1e3) return Math.round(v).toLocaleString("en-US");
    return kind === "dec" ? one(v) : String(Math.round(v));
  }

  function setup(plot) {
    var data;
    try { data = JSON.parse(plot.getAttribute("data-chart")); } catch (e) { return; }
    var svg = plot.querySelector("svg");
    var tip = plot.querySelector(".tip");
    var xhair = svg.querySelector(".xhair");
    var band = svg.querySelector(".hover-band");
    var n = data.labels.length;
    if (!n || plot.classList.contains("is-empty")) return;
    var current = -1;

    function show(i) {
      current = Math.max(0, Math.min(n - 1, i));
      var x = data.x0 + current * data.step;
      if (xhair) {
        xhair.setAttribute("x1", x);
        xhair.setAttribute("x2", x);
        xhair.setAttribute("visibility", "visible");
      }
      if (band) {
        band.setAttribute("x", x - data.step / 2);
        band.setAttribute("width", data.step);
        band.setAttribute("visibility", "visible");
      }
      tip.textContent = "";
      var head = document.createElement("div");
      head.className = "tip-head";
      head.textContent = data.labels[current];
      tip.appendChild(head);
      var total = 0;
      // Stacked columns list top segment first, the way they read on the chart.
      var list = data.stacked ? data.series.slice().reverse() : data.series;
      for (var k = 0; k < list.length; k++) {
        var s = list[k];
        var v = s.values[current] || 0;
        total += v;
        var row = document.createElement("div");
        row.className = "tip-row";
        var key = document.createElement("span");
        key.className = "key line s" + s.slot;
        var val = document.createElement("strong");
        val.textContent = format(v, data.kind);
        var name = document.createElement("span");
        name.textContent = s.name;
        row.appendChild(key);
        row.appendChild(val);
        row.appendChild(name);
        tip.appendChild(row);
      }
      if (data.stacked && list.length > 1) {
        var sum = document.createElement("div");
        sum.className = "tip-row tip-total";
        var sv = document.createElement("strong");
        sv.textContent = format(total, data.kind);
        var sl = document.createElement("span");
        sl.textContent = "Total";
        sum.appendChild(sv);
        sum.appendChild(sl);
        tip.appendChild(sum);
      }
      tip.hidden = false;
      // Place the tip beside the crosshair, flipping to the left near the right edge.
      var rect = svg.getBoundingClientRect();
      var px = (x / data.w) * rect.width;
      var left = px + 12;
      if (left + tip.offsetWidth > rect.width) left = px - tip.offsetWidth - 12;
      tip.style.left = Math.max(0, left) + "px";
      tip.style.top = "8px";
    }

    function hide() {
      current = -1;
      tip.hidden = true;
      if (xhair) xhair.setAttribute("visibility", "hidden");
      if (band) band.setAttribute("visibility", "hidden");
    }

    plot.addEventListener("pointermove", function (ev) {
      var rect = svg.getBoundingClientRect();
      var x = ((ev.clientX - rect.left) / rect.width) * data.w;
      show(Math.round((x - data.x0) / (data.step || 1)));
    });
    plot.addEventListener("pointerleave", hide);
    plot.addEventListener("focus", function () { show(current < 0 ? n - 1 : current); });
    plot.addEventListener("blur", hide);
    plot.addEventListener("keydown", function (ev) {
      if (ev.key === "ArrowLeft" || ev.key === "ArrowRight") {
        ev.preventDefault();
        show((current < 0 ? n - 1 : current) + (ev.key === "ArrowLeft" ? -1 : 1));
      } else if (ev.key === "Home" || ev.key === "End") {
        ev.preventDefault();
        show(ev.key === "Home" ? 0 : n - 1);
      } else if (ev.key === "Escape") {
        hide();
      }
    });
  }

  var plots = document.querySelectorAll(".plot[data-chart]");
  for (var i = 0; i < plots.length; i++) setup(plots[i]);
})();
