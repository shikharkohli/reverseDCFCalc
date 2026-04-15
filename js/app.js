/* ============================================================
   app.js — DOM wiring for the reverse DCF calculator.
   Depends on: window.ExcelParser, window.ReverseDCF.
   ============================================================ */

(function () {
  "use strict";

  // ----- State -----
  var state = {
    parsed: null,   // output of ExcelParser.parse
    fcf0: null,     // base FCF
    fcfYears: null, // years used for base FCF
  };

  // Default scenario grid axes.
  var HORIZONS  = [5, 7, 10, 15];
  var TERMINALS = [0.02, 0.03, 0.04, 0.05];

  // ----- DOM helpers -----
  function $(id) { return document.getElementById(id); }

  function show(el)  { el.classList.remove("hidden"); }
  function hide(el)  { el.classList.add("hidden"); }

  function setError(el, msg) {
    if (!msg) { hide(el); el.textContent = ""; return; }
    el.textContent = msg;
    show(el);
  }

  // Format a number of ₹ crore in Indian style with one decimal for large,
  // thousands comma grouping.
  function fmtCrore(n) {
    if (n == null || !isFinite(n)) return "—";
    var abs = Math.abs(n);
    var s;
    if (abs >= 100000)       s = (n / 100000).toFixed(2) + " lakh cr";
    else if (abs >= 1000)    s = n.toFixed(0);
    else                     s = n.toFixed(1);
    return "₹ " + s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  function fmtPrice(n) {
    if (n == null) return "—";
    return "₹ " + Number(n).toLocaleString("en-IN", { maximumFractionDigits: 2 });
  }

  function fmtPct(x, digits) {
    if (x == null || !isFinite(x)) return "—";
    return (x * 100).toFixed(digits == null ? 1 : digits) + "%";
  }

  // ----- File upload -----
  function wireUpload() {
    var input    = $("file-input");
    var dropzone = $("dropzone");
    var errorEl  = $("upload-error");

    input.addEventListener("change", function () {
      if (input.files && input.files[0]) handleFile(input.files[0], errorEl);
    });

    ["dragenter", "dragover"].forEach(function (evt) {
      dropzone.addEventListener(evt, function (e) {
        e.preventDefault();
        e.stopPropagation();
        dropzone.classList.add("dragover");
      });
    });
    ["dragleave", "drop"].forEach(function (evt) {
      dropzone.addEventListener(evt, function (e) {
        e.preventDefault();
        e.stopPropagation();
        dropzone.classList.remove("dragover");
      });
    });
    dropzone.addEventListener("drop", function (e) {
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) handleFile(f, errorEl);
    });
  }

  function handleFile(file, errorEl) {
    setError(errorEl, null);
    if (!/\.xlsx?$/i.test(file.name)) {
      setError(errorEl, "Please upload a .xlsx file exported from Screener.in.");
      return;
    }
    var reader = new FileReader();
    reader.onerror = function () {
      setError(errorEl, "Could not read the file. Try a different browser.");
    };
    reader.onload = function (e) {
      try {
        var parsed = ExcelParser.parse(e.target.result);
        var fcf    = ReverseDCF.computeBaseFCF(parsed);
        state.parsed    = parsed;
        state.fcf0      = fcf.value;
        state.fcfYears  = fcf.years;
        renderCompanySummary();
        recalc();
      } catch (err) {
        setError(errorEl, err.message || String(err));
        hide($("company-summary"));
        hide($("results-content"));
        show($("results-empty"));
      }
    };
    reader.readAsArrayBuffer(file);
  }

  function renderCompanySummary() {
    var p = state.parsed;
    $("sum-name").textContent  = p.companyName || "—";
    $("sum-price").textContent = fmtPrice(p.currentPrice);
    $("sum-mcap").textContent  = fmtCrore(p.marketCap);
    $("sum-fcf").textContent   = fmtCrore(state.fcf0);
    show($("company-summary"));
  }

  // ----- Parameters -----
  function readParams() {
    var r  = Number($("param-r").value)  / 100;
    var N  = Math.round(Number($("param-n").value));
    var gT = Number($("param-gt").value) / 100;
    return { r: r, N: N, gT: gT };
  }

  function wireParams() {
    ["param-r", "param-n", "param-gt"].forEach(function (id) {
      $(id).addEventListener("input", recalc);
    });
  }

  // ----- Recalculation -----
  function recalc() {
    var errorEl = $("params-error");
    setError(errorEl, null);

    if (state.parsed == null || state.fcf0 == null) {
      hide($("results-content"));
      show($("results-empty"));
      return;
    }

    var p = readParams();
    if (!(p.r > 0 && p.r < 1)) {
      setError(errorEl, "Discount rate must be between 0 and 100%.");
      return;
    }
    if (!(p.N >= 3 && p.N <= 25)) {
      setError(errorEl, "Projection horizon must be between 3 and 25 years.");
      return;
    }
    if (!(p.gT >= 0 && p.gT < p.r)) {
      setError(errorEl, "Terminal growth must be ≥ 0 and strictly less than the discount rate.");
      return;
    }

    hide($("results-empty"));
    show($("results-content"));

    // Headline solve for user's chosen (r, N, gT)
    try {
      var target = state.parsed.marketCap;
      var res    = ReverseDCF.solveImpliedGrowth(target, state.fcf0, p.gT, p.r, p.N);
      var band   = ReverseDCF.classify(res.g);
      renderHeadline(res, band);
    } catch (err) {
      setError(errorEl, err.message || String(err));
      hide($("results-content"));
      show($("results-empty"));
      return;
    }

    // Scenario grid uses the same discount rate across all cells.
    var grid = ReverseDCF.scenarioGrid(
      state.parsed.marketCap, state.fcf0, p.r, HORIZONS, TERMINALS
    );
    renderGrid(grid);
  }

  function renderHeadline(res, band) {
    var value = fmtPct(res.g, 2);
    if (res.clamped === "high") value = "> " + fmtPct(res.g, 0);
    if (res.clamped === "low")  value = "< " + fmtPct(res.g, 0);

    $("headline-g").textContent = value;

    var badge = $("verdict-badge");
    badge.textContent = band.label;
    badge.className = "verdict-badge " + band.key;

    $("verdict-explainer").textContent = ReverseDCF.verdictExplainer(res.g, band);
  }

  function renderGrid(grid) {
    var table = $("scenario-grid");
    var html = "";
    // Header row
    html += "<thead><tr><th>N \\ g<sub>T</sub></th>";
    grid.terminals.forEach(function (gT) {
      html += "<th>" + (gT * 100).toFixed(1) + "%</th>";
    });
    html += "</tr></thead><tbody>";
    grid.cells.forEach(function (row, i) {
      html += "<tr><th>" + grid.horizons[i] + " yrs</th>";
      row.forEach(function (cell) {
        if (cell.error) {
          html += "<td class=\"err\" title=\"" + escapeAttr(cell.error) + "\">—</td>";
        } else {
          var val = (cell.g * 100).toFixed(1) + "%";
          if (cell.clamped === "high") val = "&gt; " + val;
          if (cell.clamped === "low")  val = "&lt; " + val;
          html += "<td class=\"" + cell.band.key + "\">" + val + "</td>";
        }
      });
      html += "</tr>";
    });
    html += "</tbody>";
    table.innerHTML = html;
  }

  function escapeAttr(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  // ----- Init -----
  document.addEventListener("DOMContentLoaded", function () {
    wireUpload();
    wireParams();
  });
})();
