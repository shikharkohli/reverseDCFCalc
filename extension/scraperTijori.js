/* ============================================================
   scraperTijori.js — Extracts financial data from a
   tijorifinance.com company financials page.

   Data sources on the page:
     1. <script id="fin_tables_data" type="application/json">
        Contains all financial tables as structured JSON with keys
        like cf_c (cash flow consolidated), pl_c (P&L consolidated).
     2. h1.company_main_heading           → company name
     3. .share_price .price               → current share price
     4. .company_details_box
        .company_details_value            → market cap (first match)
     5. HTML tables with class "fin_table" → fallback for cash flow

   Returns the same shape as ScreenerScraper.scrape() so that
   ReverseDCF.computeBaseFCF() works unchanged.
   ============================================================ */

window.TijoriScraper = (function () {
  "use strict";

  function norm(s) {
    return (s || "").replace(/ /g, " ").replace(/\s+/g, " ").trim();
  }

  function toNumber(text) {
    if (text == null) return null;
    var s = String(text).replace(/ /g, " ").trim();
    if (!s) return null;
    s = s.replace(/[,₹\s%]/g, "");
    if (!s || s === "-" || s === "—") return null;
    var n = Number(s);
    return isFinite(n) ? n : null;
  }

  function readCompanyName() {
    var h = document.querySelector("h1.company_main_heading");
    if (h) return norm(h.textContent);
    var title = (document.title || "").split(/[—|-]/)[0];
    return title.trim() || "Unknown";
  }

  function readPrice() {
    var el = document.querySelector(".share_price .price");
    if (!el) return null;
    return toNumber(el.textContent);
  }

  function readMarketCap() {
    var boxes = document.querySelectorAll(".company_details_box");
    for (var i = 0; i < boxes.length; i++) {
      var label = boxes[i].querySelector(".company_details_key");
      if (!label) continue;
      if (/market\s*cap/i.test(label.textContent)) {
        var val = boxes[i].querySelector(".company_details_value");
        if (val) {
          var text = val.textContent.replace(/Cr\.?/gi, "").trim();
          return toNumber(text);
        }
      }
    }
    var vals = document.querySelectorAll(".company_details_value");
    if (vals.length > 0) {
      var text = vals[0].textContent.replace(/Cr\.?/gi, "").trim();
      return toNumber(text);
    }
    return null;
  }

  function findSeriesByName(dataArray, name) {
    var target = name.toLowerCase();
    for (var i = 0; i < dataArray.length; i++) {
      var item = dataArray[i];
      var label = (item.name || item.label || "").toLowerCase();
      if (label.indexOf(target) !== -1) {
        return item.value || item.values || [];
      }
    }
    return null;
  }

  function scrapeFromJSON() {
    var script = document.getElementById("fin_tables_data");
    if (!script) return null;

    var json;
    try {
      json = JSON.parse(script.textContent);
    } catch (e) {
      return null;
    }

    var cf = json.cf_c || json.cf_s || json.cf;
    if (!cf || !cf.data || !cf.report_dates) return null;

    var dates = cf.report_dates;
    var cfoValues = findSeriesByName(cf.data, "cash from operating");
    var cfiValues = findSeriesByName(cf.data, "cash from investing");

    if (!cfoValues || !cfiValues) return null;

    var cols = [];
    for (var i = 0; i < dates.length; i++) {
      cols.push({
        index: i,
        label: dates[i],
        key: dates[i],
      });
    }

    var cfo = cols.map(function (c) {
      var v = cfoValues[c.index];
      return v != null && isFinite(v) ? v : null;
    });
    var cfi = cols.map(function (c) {
      var v = cfiValues[c.index];
      return v != null && isFinite(v) ? v : null;
    });

    return { cols: cols, cfo: cfo, cfi: cfi };
  }

  function scrapeFromHTML() {
    var tables = document.querySelectorAll("table.fin_table");
    var cfTable = null;

    for (var t = 0; t < tables.length; t++) {
      var rows = tables[t].querySelectorAll("tbody tr, tr");
      for (var r = 0; r < rows.length; r++) {
        var firstCell = rows[r].querySelector("td");
        if (firstCell && /cash from operating/i.test(firstCell.textContent)) {
          cfTable = tables[t];
          break;
        }
      }
      if (cfTable) break;
    }

    if (!cfTable) return null;

    var headerRow = cfTable.querySelector("thead tr") || cfTable.querySelector("tr");
    if (!headerRow) return null;

    var headerCells = headerRow.querySelectorAll("th, td");
    var cols = [];
    for (var i = 1; i < headerCells.length; i++) {
      var label = norm(headerCells[i].textContent);
      if (!label || /TTM/i.test(label)) continue;
      cols.push({ index: i, label: label, key: label });
    }

    if (cols.length === 0) return null;

    var allRows = cfTable.querySelectorAll("tbody tr, tr");
    var cfo = null;
    var cfi = null;

    for (var r = 0; r < allRows.length; r++) {
      var cells = allRows[r].querySelectorAll("td");
      if (cells.length === 0) continue;
      var rowName = norm(cells[0].textContent).toLowerCase();

      if (/cash from operating/i.test(rowName)) {
        cfo = cols.map(function (c) {
          return cells[c.index] ? toNumber(cells[c.index].textContent) : null;
        });
      }
      if (/cash from investing/i.test(rowName)) {
        cfi = cols.map(function (c) {
          return cells[c.index] ? toNumber(cells[c.index].textContent) : null;
        });
      }
    }

    if (!cfo || !cfi) return null;
    return { cols: cols, cfo: cfo, cfi: cfi };
  }

  function scrape() {
    var currentPrice = readPrice();
    var marketCap = readMarketCap();

    if (currentPrice == null || marketCap == null) {
      throw new Error(
        "Could not read Current Price / Market Cap from the page header."
      );
    }

    var data = scrapeFromJSON();
    if (!data) data = scrapeFromHTML();

    if (!data) {
      throw new Error(
        "Could not find Cash Flow data on this page. " +
        "Make sure you are on a Tijori Finance company financials page."
      );
    }

    return {
      companyName: readCompanyName(),
      currentPrice: currentPrice,
      marketCap: marketCap,
      annualColumns: data.cols,
      annual: {
        cfo: data.cfo,
        cfi: data.cfi,
      },
    };
  }

  return { scrape: scrape };
})();
