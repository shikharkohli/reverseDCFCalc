/* ============================================================
   scraper.js — Extracts financial data from a Screener.in company
   page DOM. Returns a structure compatible with what the Excel
   parser used on the standalone website.

   DOM structure (observed on /company/:SYMBOL/ and .../consolidated/):
     #top h1                         → company name
     #top-ratios li
       .name                         → metric label (text)
       .value .number                → metric value (text)
     section#profit-loss table.data-table
     section#balance-sheet table.data-table
     section#cash-flow table.data-table
       thead th[data-date-key]       → column keys (YYYY-MM-DD or "TTM")
       tbody tr td.text              → row label (either direct text or in
                                        a nested <button class="button-plain">)
       tbody tr td                   → numeric cells, commas + possibly "-"
   ============================================================ */

window.ScreenerScraper = (function () {
  "use strict";

  function norm(s) {
    return (s || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  }

  function normLower(s) {
    return norm(s).toLowerCase();
  }

  // Convert Screener's numeric string to a number.
  //  "18,27,979"  -> 1827979
  //  "-73,070"    -> -73070
  //  "1,234.56"   -> 1234.56
  //  "" or null   -> null
  function toNumber(text) {
    if (text == null) return null;
    var s = String(text).replace(/\u00a0/g, " ").trim();
    if (!s) return null;
    // Remove Indian/Western thousands commas, "%", "₹" etc.
    s = s.replace(/[,₹\s%]/g, "");
    if (!s || s === "-") return null;
    var n = Number(s);
    return isFinite(n) ? n : null;
  }

  // Extract a top-ratio value by its visible label.
  function readTopRatio(label) {
    var items = document.querySelectorAll("#top-ratios li");
    var target = normLower(label);
    for (var i = 0; i < items.length; i++) {
      var name = items[i].querySelector(".name");
      if (!name) continue;
      if (normLower(name.textContent) === target) {
        var number = items[i].querySelector(".value .number");
        if (!number) return null;
        return toNumber(number.textContent);
      }
    }
    return null;
  }

  // Read the company name from the #top card header.
  function readCompanyName() {
    var h = document.querySelector("#top h1");
    if (h) return norm(h.textContent);
    // Fallback to document.title: "Reliance Industries Ltd - Share Price, ..."
    return (document.title || "").split(/[—|-]/)[0].trim() || "Unknown";
  }

  // Return the <table class="data-table"> inside a given section id, or null.
  function getSectionTable(sectionId) {
    var section = document.getElementById(sectionId);
    if (!section) return null;
    return section.querySelector("table.data-table");
  }

  // Extract annual columns from a table's thead. Skips TTM.
  //   returns [{ key: "2024-03-31", label: "Mar 2024", index: 1 }, ...]
  // `index` is the column index within the <tr> (the label <td.text> is 0).
  function getColumns(table) {
    var ths = table.querySelectorAll("thead th");
    var cols = [];
    for (var i = 0; i < ths.length; i++) {
      var key = ths[i].getAttribute("data-date-key");
      if (!key) continue; // skip the empty label header
      if (/TTM/i.test(key)) continue; // we want annual periods only
      cols.push({
        key: key,
        label: norm(ths[i].textContent),
        index: i, // matches td position in the tr
      });
    }
    return cols;
  }

  // Get the row-label text for a <tr>. The first <td class="text"> either
  // contains a direct text node or a nested <button class="button-plain">.
  function rowLabel(tr) {
    var labelCell = tr.querySelector("td.text");
    if (!labelCell) return "";
    var btn = labelCell.querySelector("button.button-plain");
    var raw = btn ? btn.textContent : labelCell.textContent;
    // Strip the trailing "+ " that marks expandable rows.
    return norm(raw).replace(/\s*\+\s*$/, "");
  }

  // Find a row whose label matches `needle` (case-insensitive exact match).
  // Returns the numeric series aligned to `cols`, or an array of nulls.
  function readRow(table, cols, needle) {
    if (!table) return cols.map(function () { return null; });
    var target = normLower(needle);
    var rows = table.querySelectorAll("tbody tr");
    for (var i = 0; i < rows.length; i++) {
      if (normLower(rowLabel(rows[i])) !== target) continue;
      var cells = rows[i].children;
      return cols.map(function (c) {
        var td = cells[c.index];
        return td ? toNumber(td.textContent) : null;
      });
    }
    return cols.map(function () { return null; });
  }

  /**
   * Scrape everything needed for the reverse DCF.
   * Throws if critical fields are missing.
   */
  function scrape() {
    var cfTable = getSectionTable("cash-flow");
    if (!cfTable) {
      throw new Error(
        "This page doesn't look like a Screener.in company page — " +
        "missing the Cash Flow table."
      );
    }

    // Use the cash-flow table's columns as the canonical annual axis; its
    // row labels are the ones we solve against (CFO, CFI). P&L has a TTM
    // column that cash-flow doesn't, so cash-flow is the tighter set.
    var cols = getColumns(cfTable);
    if (cols.length === 0) {
      throw new Error("No annual columns found in the Cash Flow table.");
    }

    var currentPrice = readTopRatio("Current Price");
    var marketCap    = readTopRatio("Market Cap");
    if (currentPrice == null || marketCap == null) {
      throw new Error(
        "Could not read Current Price / Market Cap from the top ratios block."
      );
    }

    // The calculator only needs CFO and CFI aligned to `cols`.
    var cfo = readRow(cfTable, cols, "Cash from Operating Activity");
    var cfi = readRow(cfTable, cols, "Cash from Investing Activity");

    return {
      companyName: readCompanyName(),
      currentPrice: currentPrice,
      marketCap: marketCap,
      annualColumns: cols.map(function (c) {
        return { index: c.index, label: c.label, key: c.key };
      }),
      annual: {
        cfo: cfo,
        cfi: cfi,
      },
    };
  }

  return { scrape: scrape };
})();
