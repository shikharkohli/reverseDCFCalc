/* ============================================================
   reverseDCF.js — Pure financial calculations.

   All rates (r, gT, g) are expressed as decimals (0.12 == 12%).
   All money values are in ₹ crore and must use a consistent unit
   across FCF₀ and market cap (Screener uses ₹ crore for both).
   ============================================================ */

window.ReverseDCF = (function () {
  "use strict";

  /**
   * Compute the base free cash flow used for the DCF.
   *
   * Definition: mean of (CFO - |CFI|) over the last up-to-3 years where
   * BOTH CFO and CFI are reported. CFI is used as a capex proxy — it's
   * Screener's "Cash from Investing Activity", which includes capex but
   * also acquisitions and strategic investments.
   *
   * Returns { value, years: [{label, cfo, cfi, fcf}, ...] }.
   * Throws Error if no usable years are available.
   */
  function computeBaseFCF(parsed) {
    var cols = parsed.annualColumns;
    var cfo = parsed.annual.cfo;
    var cfi = parsed.annual.cfi;

    // Walk from newest (rightmost) backwards, collect up to 3 valid years.
    var collected = [];
    for (var i = cols.length - 1; i >= 0 && collected.length < 3; i--) {
      var o = cfo[i];
      var v = cfi[i];
      if (o == null || v == null) continue;
      var fcf = o - Math.abs(v);
      collected.push({
        label: cols[i].label,
        cfo: o,
        cfi: v,
        fcf: fcf,
      });
    }
    if (collected.length === 0) {
      throw new Error(
        "Could not compute base FCF — no year has both CFO and CFI reported."
      );
    }

    var sum = collected.reduce(function (s, y) { return s + y.fcf; }, 0);
    var value = sum / collected.length;

    // Return years in chronological order (oldest first) for display.
    collected.reverse();
    return { value: value, years: collected };
  }

  /**
   * Forward DCF value for a given growth rate.
   *
   *   value = Σ_{t=1..N} FCF₀·(1+g)^t / (1+r)^t
   *         + [ FCF₀·(1+g)^N · (1+gT) / (r − gT) ] / (1+r)^N
   */
  function dcfValue(fcf0, g, gT, r, N) {
    if (r <= gT) {
      throw new Error(
        "Discount rate (r) must be strictly greater than terminal growth (g_T)."
      );
    }
    var sum = 0;
    var fcfT = fcf0;
    var discount = 1;
    var onePlusR = 1 + r;
    var onePlusG = 1 + g;
    for (var t = 1; t <= N; t++) {
      fcfT *= onePlusG;
      discount *= onePlusR;
      sum += fcfT / discount;
    }
    // Terminal value at end of year N, then discount to present.
    var terminal = (fcfT * (1 + gT)) / (r - gT);
    sum += terminal / discount;
    return sum;
  }

  /**
   * Bisection solver for the implied FCF growth rate.
   *
   * Returns a decimal (e.g. 0.094 == 9.4%). If the required growth is
   * outside [-0.20, +0.80], returns the clamped value and sets .clamped.
   */
  function solveImpliedGrowth(target, fcf0, gT, r, N) {
    if (!(fcf0 > 0)) {
      throw new Error(
        "Base FCF is non-positive (" + fcf0.toFixed(0) +
        " ₹ cr). Reverse DCF is not meaningful for companies that " +
        "don't generate free cash."
      );
    }
    if (r <= gT) {
      throw new Error(
        "Discount rate must exceed terminal growth (r > g_T)."
      );
    }

    var lo = -0.20;
    var hi = 0.80;
    var vLo = dcfValue(fcf0, lo, gT, r, N);
    var vHi = dcfValue(fcf0, hi, gT, r, N);

    // dcfValue is monotonically increasing in g (when g < r). If the
    // target is outside [vLo, vHi] we flag clamping.
    if (target <= vLo) {
      return { g: lo, clamped: "low", iterations: 0 };
    }
    if (target >= vHi) {
      return { g: hi, clamped: "high", iterations: 0 };
    }

    var iterations = 0;
    var g;
    for (var i = 0; i < 200; i++) {
      iterations = i + 1;
      g = (lo + hi) / 2;
      var v = dcfValue(fcf0, g, gT, r, N);
      if (Math.abs(v - target) / target < 1e-7) break;
      if (v < target) lo = g;
      else hi = g;
      if (hi - lo < 1e-8) break;
    }
    return { g: g, clamped: null, iterations: iterations };
  }

  // ----- Investibility bands (GDP-anchored) --------------------------------
  var BANDS = [
    { max: 0.08, key: "investible", label: "Investible" },
    { max: 0.13, key: "fair",       label: "Fair" },
    { max: 0.18, key: "expensive",  label: "Expensive" },
    { max: Infinity, key: "overvalued", label: "Overvalued" },
  ];

  function classify(g) {
    for (var i = 0; i < BANDS.length; i++) {
      if (g < BANDS[i].max) return BANDS[i];
    }
    return BANDS[BANDS.length - 1];
  }

  function verdictExplainer(g, band) {
    var pct = (g * 100).toFixed(1) + "%";
    switch (band.key) {
      case "investible":
        return (
          "The market is pricing in only " + pct + " annual FCF growth — " +
          "below Indian nominal GDP. If the business can deliver even " +
          "average growth, there is room for upside."
        );
      case "fair":
        return (
          "Implied growth of " + pct + " is roughly in line with Indian " +
          "nominal GDP. You are paying a fair price; returns will come " +
          "from execution, not multiple expansion."
        );
      case "expensive":
        return (
          "The price embeds " + pct + " growth — meaningfully above trend. " +
          "The business needs a durable moat and disciplined capital " +
          "allocation to justify this."
        );
      case "overvalued":
        return (
          "The market demands " + pct + " compounding for years. Very few " +
          "companies sustain that. Margin of safety is thin or negative."
        );
    }
    return "";
  }

  /**
   * Build the scenario grid for horizons × terminal growths.
   * Returns { horizons, terminals, cells: [[{g, band} | {error}], ...] }
   */
  function scenarioGrid(target, fcf0, r, horizons, terminals) {
    var cells = horizons.map(function (N) {
      return terminals.map(function (gT) {
        try {
          var res = solveImpliedGrowth(target, fcf0, gT, r, N);
          return { g: res.g, band: classify(res.g), clamped: res.clamped };
        } catch (e) {
          return { error: e.message };
        }
      });
    });
    return { horizons: horizons, terminals: terminals, cells: cells };
  }

  return {
    computeBaseFCF: computeBaseFCF,
    dcfValue: dcfValue,
    solveImpliedGrowth: solveImpliedGrowth,
    scenarioGrid: scenarioGrid,
    classify: classify,
    verdictExplainer: verdictExplainer,
  };
})();
