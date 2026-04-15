/* ============================================================
   content.js — Chrome content script that injects a "Reverse DCF"
   section into a Screener.in company page.

   Depends on (same content_scripts entry):
     - window.ReverseDCF  (reverseDCF.js)
     - window.ScreenerScraper (scraper.js)
   ============================================================ */

(function () {
  "use strict";

  var SECTION_ID = "rdcf-section";
  var HORIZONS   = [5, 7, 10, 15];
  var TERMINALS  = [0.02, 0.03, 0.04, 0.05];
  var STORAGE_KEY = "rdcf.params";

  // State for the currently-scraped page.
  var state = {
    scraped: null,
    fcf0: null,
    fcfYears: null,
  };

  // -----------------------------------------------------------
  // Formatting helpers
  // -----------------------------------------------------------
  function fmtCrore(n) {
    if (n == null || !isFinite(n)) return "—";
    var abs = Math.abs(n);
    if (abs >= 100000) return "₹ " + (n / 100000).toFixed(2) + " lakh cr";
    if (abs >= 1000)   return "₹ " + Math.round(n).toLocaleString("en-IN") + " cr";
    return "₹ " + n.toFixed(1) + " cr";
  }
  function fmtPrice(n) {
    if (n == null) return "—";
    return "₹ " + Number(n).toLocaleString("en-IN", { maximumFractionDigits: 2 });
  }
  function fmtPct(x, d) {
    if (x == null || !isFinite(x)) return "—";
    return (x * 100).toFixed(d == null ? 1 : d) + "%";
  }
  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // -----------------------------------------------------------
  // Persisted params
  // -----------------------------------------------------------
  function loadParams() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        var p = JSON.parse(raw);
        if (p && typeof p.r === "number") return p;
      }
    } catch (e) { /* ignore */ }
    return { r: 12, N: 10, gT: 4 };
  }
  function saveParams(p) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(p)); } catch (e) {}
  }

  // -----------------------------------------------------------
  // HTML templates
  // -----------------------------------------------------------
  function sectionHTML() {
    var p = loadParams();
    return (
      '<div class="rdcf-header">' +
        '<h2>Reverse DCF</h2>' +
        '<p class="rdcf-sub">What annual FCF growth rate does today\'s market cap imply?</p>' +
      '</div>' +

      '<div class="rdcf-grid-top">' +
        '<div class="rdcf-summary">' +
          '<div class="rdcf-summary-item"><span class="rdcf-label">Company</span><span class="rdcf-value" id="rdcf-name">—</span></div>' +
          '<div class="rdcf-summary-item"><span class="rdcf-label">Current Price</span><span class="rdcf-value" id="rdcf-price">—</span></div>' +
          '<div class="rdcf-summary-item"><span class="rdcf-label">Market Cap</span><span class="rdcf-value" id="rdcf-mcap">—</span></div>' +
          '<div class="rdcf-summary-item"><span class="rdcf-label">Base FCF (3-yr avg)</span><span class="rdcf-value" id="rdcf-fcf">—</span></div>' +
        '</div>' +

        '<div class="rdcf-params">' +
          '<label class="rdcf-field">' +
            '<span class="rdcf-field-label">Discount rate (r)</span>' +
            '<div class="rdcf-input"><input type="number" id="rdcf-r" value="' + p.r + '" min="1" max="30" step="0.5"/><span>%</span></div>' +
          '</label>' +
          '<label class="rdcf-field">' +
            '<span class="rdcf-field-label">Projection horizon (N)</span>' +
            '<div class="rdcf-input"><input type="number" id="rdcf-n" value="' + p.N + '" min="3" max="25" step="1"/><span>yrs</span></div>' +
          '</label>' +
          '<label class="rdcf-field">' +
            '<span class="rdcf-field-label">Terminal growth (g<sub>T</sub>)</span>' +
            '<div class="rdcf-input"><input type="number" id="rdcf-gt" value="' + p.gT + '" min="0" max="8" step="0.25"/><span>%</span></div>' +
          '</label>' +
        '</div>' +
      '</div>' +

      '<div class="rdcf-error rdcf-hidden" id="rdcf-error"></div>' +

      '<div class="rdcf-results" id="rdcf-results">' +
        '<div class="rdcf-headline">' +
          '<div class="rdcf-headline-main">' +
            '<span class="rdcf-label">Implied FCF growth baked into the price</span>' +
            '<span class="rdcf-headline-value" id="rdcf-g">—</span>' +
          '</div>' +
          '<div class="rdcf-headline-verdict">' +
            '<span class="rdcf-label">Verdict</span>' +
            '<span class="rdcf-verdict" id="rdcf-verdict">—</span>' +
          '</div>' +
        '</div>' +
        '<p class="rdcf-explainer" id="rdcf-explainer"></p>' +

        '<h3 class="rdcf-subhead">Sensitivity grid — implied growth (%)</h3>' +
        '<p class="rdcf-sub rdcf-small">Rows = projection horizon N. Columns = terminal growth g<sub>T</sub>. Discount rate from the input above.</p>' +
        '<div class="rdcf-grid-wrap"><table class="rdcf-scenario" id="rdcf-scenario"></table></div>' +
        '<div class="rdcf-legend">' +
          '<span class="rdcf-legend-item"><span class="rdcf-chip rdcf-investible"></span> Investible (&lt;8%)</span>' +
          '<span class="rdcf-legend-item"><span class="rdcf-chip rdcf-fair"></span> Fair (8–13%)</span>' +
          '<span class="rdcf-legend-item"><span class="rdcf-chip rdcf-expensive"></span> Expensive (13–18%)</span>' +
          '<span class="rdcf-legend-item"><span class="rdcf-chip rdcf-overvalued"></span> Overvalued (≥18%)</span>' +
        '</div>' +
      '</div>' +

      '<details class="rdcf-details" open>' +
        '<summary>Assumptions baked into this model</summary>' +
        '<ul>' +
          '<li><strong>Base FCF</strong> = mean of the last 3 annual years of (Cash from Operating − |Cash from Investing|). Investing cash flow is used as a capex proxy and also includes acquisitions / strategic investments.</li>' +
          '<li><strong>Discount rate</strong> default 12% — a rough proxy for Indian equity cost of capital. Adjust it above.</li>' +
          '<li><strong>Constant growth</strong> during the projection horizon.</li>' +
          '<li><strong>Terminal value</strong> uses the Gordon Growth Model applied at year N. This often accounts for &gt;60% of intrinsic value.</li>' +
          '<li><strong>Equity DCF</strong> — present value of FCFs is compared directly to market cap, implicitly assuming capital structure stays stable.</li>' +
          '<li><strong>No dilution or buybacks</strong> during projection; share count is whatever Screener reports.</li>' +
          '<li><strong>Tax rate</strong> is whatever the reported P&L implies — no normalisation.</li>' +
          '<li><strong>Investibility bands</strong> are GDP-anchored heuristics, not advice: &lt;8% Investible, 8–13% Fair, 13–18% Expensive, ≥18% Overvalued.</li>' +
        '</ul>' +
      '</details>' +

      '<details class="rdcf-details rdcf-warn">' +
        '<summary>Limitations of DCF analysis — read before trusting the number</summary>' +
        '<ol>' +
          '<li><strong>Garbage in, garbage out.</strong> Historical CFO can be distorted by working-capital swings, one-offs or aggressive accounting.</li>' +
          '<li><strong>Terminal value dominates.</strong> Small changes in r or g<sub>T</sub> swing the answer dramatically.</li>' +
          '<li><strong>Constant-growth fiction.</strong> Real companies face S-curves, disruption and competitive decay; linear compounding is a convenient lie.</li>' +
          '<li><strong>Discount rate is arbitrary.</strong> No single "correct" cost of capital — reasonable analysts can justify 10% or 14% for the same business.</li>' +
          '<li><strong>Not suitable for</strong> banks, NBFCs, insurers (cash flow ≠ value driver), early-stage or loss-making companies, or deep cyclicals observed at trough/peak.</li>' +
          '<li><strong>Ignores optionality</strong> — new businesses, M&A potential, capital-allocation skill and moat evolution are not captured.</li>' +
          '<li><strong>Break-even, not a buy signal.</strong> "Implied growth" tells you what the market expects; it does not build in any margin of safety.</li>' +
          '<li><strong>Point-in-time.</strong> Reflects latest reported financials only — no forward guidance, management commentary or post-reporting events.</li>' +
          '<li><strong>Screener data caveats.</strong> Consolidated vs standalone, restated numbers, and missing segments all affect the output.</li>' +
        '</ol>' +
        '<p class="rdcf-sub rdcf-small"><em>Educational tool · Not investment advice · Do your own research.</em></p>' +
      '</details>'
    );
  }

  // -----------------------------------------------------------
  // Injection
  // -----------------------------------------------------------
  function buildSection() {
    var section = document.createElement("section");
    section.id = SECTION_ID;
    section.className = "card card-large rdcf-card";
    section.innerHTML = sectionHTML();
    return section;
  }

  function insertSection(section) {
    // Place the DCF section right after Cash Flow so users see it next to
    // the numbers it depends on. Fallback to end of main content.
    var cf = document.getElementById("cash-flow");
    if (cf && cf.parentNode) {
      cf.parentNode.insertBefore(section, cf.nextSibling);
      return;
    }
    var main = document.querySelector(".company-info, main, body");
    if (main) main.appendChild(section);
  }

  // -----------------------------------------------------------
  // Render logic
  // -----------------------------------------------------------
  function renderSummary() {
    var s = state.scraped;
    document.getElementById("rdcf-name").textContent  = s.companyName;
    document.getElementById("rdcf-price").textContent = fmtPrice(s.currentPrice);
    document.getElementById("rdcf-mcap").textContent  = fmtCrore(s.marketCap);
    document.getElementById("rdcf-fcf").textContent   = fmtCrore(state.fcf0);
  }

  function readParamsFromUI() {
    var r  = Number(document.getElementById("rdcf-r").value) / 100;
    var N  = Math.round(Number(document.getElementById("rdcf-n").value));
    var gT = Number(document.getElementById("rdcf-gt").value) / 100;
    return { r: r, N: N, gT: gT };
  }

  function setError(msg) {
    var el = document.getElementById("rdcf-error");
    if (!el) return;
    if (!msg) { el.classList.add("rdcf-hidden"); el.textContent = ""; return; }
    el.classList.remove("rdcf-hidden");
    el.textContent = msg;
  }

  function recalc() {
    if (!state.scraped || state.fcf0 == null) return;
    setError(null);

    var p = readParamsFromUI();
    if (!(p.r > 0 && p.r < 1))       return setError("Discount rate must be between 0% and 100%.");
    if (!(p.N >= 3 && p.N <= 25))     return setError("Projection horizon must be 3–25 years.");
    if (!(p.gT >= 0 && p.gT < p.r))   return setError("Terminal growth must be ≥ 0 and strictly less than the discount rate.");

    saveParams({ r: p.r * 100, N: p.N, gT: p.gT * 100 });

    var target = state.scraped.marketCap;
    var res;
    try {
      res = ReverseDCF.solveImpliedGrowth(target, state.fcf0, p.gT, p.r, p.N);
    } catch (e) {
      return setError(e.message || String(e));
    }
    var band = ReverseDCF.classify(res.g);

    // Headline
    var value = fmtPct(res.g, 2);
    if (res.clamped === "high") value = "> " + fmtPct(res.g, 0);
    if (res.clamped === "low")  value = "< " + fmtPct(res.g, 0);
    document.getElementById("rdcf-g").textContent = value;

    var verdictEl = document.getElementById("rdcf-verdict");
    verdictEl.textContent = band.label;
    verdictEl.className = "rdcf-verdict rdcf-" + band.key;

    document.getElementById("rdcf-explainer").textContent =
      ReverseDCF.verdictExplainer(res.g, band);

    // Scenario grid
    var grid = ReverseDCF.scenarioGrid(target, state.fcf0, p.r, HORIZONS, TERMINALS);
    renderGrid(grid);
  }

  function renderGrid(grid) {
    var html = "<thead><tr><th>N \\ g<sub>T</sub></th>";
    grid.terminals.forEach(function (gT) {
      html += "<th>" + (gT * 100).toFixed(1) + "%</th>";
    });
    html += "</tr></thead><tbody>";
    grid.cells.forEach(function (row, i) {
      html += "<tr><th>" + grid.horizons[i] + " yrs</th>";
      row.forEach(function (cell) {
        if (cell.error) {
          html += '<td class="rdcf-err" title="' + escapeHtml(cell.error) + '">—</td>';
        } else {
          var v = (cell.g * 100).toFixed(1) + "%";
          if (cell.clamped === "high") v = "&gt; " + v;
          if (cell.clamped === "low")  v = "&lt; " + v;
          html += '<td class="rdcf-' + cell.band.key + '">' + v + "</td>";
        }
      });
      html += "</tr>";
    });
    html += "</tbody>";
    document.getElementById("rdcf-scenario").innerHTML = html;
  }

  function wireInputs() {
    ["rdcf-r", "rdcf-n", "rdcf-gt"].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener("input", recalc);
    });
  }

  // -----------------------------------------------------------
  // Entry point
  // -----------------------------------------------------------
  function init() {
    if (document.getElementById(SECTION_ID)) return; // already injected
    // Only run on company pages that actually have the financial sections.
    if (!document.getElementById("cash-flow") || !document.getElementById("profit-loss")) {
      return;
    }

    var section = buildSection();
    insertSection(section);
    wireInputs();

    try {
      var scraped = ScreenerScraper.scrape();
      var fcf = ReverseDCF.computeBaseFCF(scraped);
      state.scraped   = scraped;
      state.fcf0      = fcf.value;
      state.fcfYears  = fcf.years;
      renderSummary();
      recalc();
    } catch (e) {
      setError(e.message || String(e));
    }
  }

  // Screener renders server-side, so run at document_idle is enough.
  // But in case the user navigates between pages via SPA-style links
  // (rare on screener), guard with a single init call.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
