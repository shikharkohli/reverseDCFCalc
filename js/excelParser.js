/* ============================================================
   excelParser.js — Parses a Screener.in "Export to Excel" workbook
   into a structured object used by the reverse DCF calculator.

   The Screener format has these sections, each starting with a
   header cell in column A:
     - COMPANY NAME / LATEST VERSION / CURRENT VERSION
     - META           (key/value pairs: shares, face value, price, mcap)
     - PROFIT & LOSS  (annual time series, first row is "Report Date")
     - Quarters       (quarterly time series)
     - BALANCE SHEET  (annual time series)
     - CASH FLOW:     (annual time series)

   We scan column A for these headers, then build a {label -> row}
   map per section and read values by (label, column).
   ============================================================ */

window.ExcelParser = (function () {
  "use strict";

  // Normalise a string for matching: trim, collapse whitespace, lower case.
  function norm(s) {
    if (s === null || s === undefined) return "";
    return String(s).replace(/\s+/g, " ").trim().toLowerCase();
  }

  // Coerce a spreadsheet cell to a finite number or null.
  function toNumber(v) {
    if (v === null || v === undefined || v === "") return null;
    if (typeof v === "number") return isFinite(v) ? v : null;
    var s = String(v).replace(/,/g, "").trim();
    if (s === "") return null;
    var n = Number(s);
    return isFinite(n) ? n : null;
  }

  // Parse a workbook ArrayBuffer into a 2D array of the first sheet.
  function sheetToRows(arrayBuffer) {
    var wb = XLSX.read(arrayBuffer, { type: "array" });
    if (!wb.SheetNames.length) throw new Error("Workbook has no sheets");
    // Prefer "Data Sheet" if present, else first sheet.
    var name = wb.SheetNames.indexOf("Data Sheet") >= 0
      ? "Data Sheet"
      : wb.SheetNames[0];
    var ws = wb.Sheets[name];
    return XLSX.utils.sheet_to_json(ws, {
      header: 1,
      blankrows: true,
      defval: null,
    });
  }

  // Return the index of the first row whose column-A matches `needle`
  // (case-insensitive, substring). Start search at `from`. -1 if missing.
  function findRow(rows, needle, from) {
    var target = norm(needle);
    for (var i = from || 0; i < rows.length; i++) {
      var cell = rows[i] && rows[i][0];
      if (cell && norm(cell).indexOf(target) !== -1) return i;
    }
    return -1;
  }

  // Return the index of the row whose column-A EXACTLY equals `needle`
  // within [from, to). -1 if missing.
  function findRowExact(rows, needle, from, to) {
    var target = norm(needle);
    var end = to == null ? rows.length : to;
    for (var i = from || 0; i < end; i++) {
      var cell = rows[i] && rows[i][0];
      if (cell && norm(cell) === target) return i;
    }
    return -1;
  }

  // From a "Report Date" row, identify data column indices and their labels.
  // Column 0 is the label column; data starts at column 1.
  function extractColumns(headerRow) {
    var cols = [];
    for (var c = 1; c < headerRow.length; c++) {
      var v = headerRow[c];
      if (v === null || v === undefined || v === "") continue;
      cols.push({ index: c, label: String(v).trim() });
    }
    return cols;
  }

  // Look up a numeric row within a section, returning an array of numbers
  // aligned to `cols`. Missing cells become null.
  function readSeries(rows, rowIdx, cols) {
    if (rowIdx < 0) return cols.map(function () { return null; });
    var row = rows[rowIdx] || [];
    return cols.map(function (c) { return toNumber(row[c.index]); });
  }

  // Read a single-value row (label in col A, value in col B). Returns
  // number or null.
  function readScalar(rows, label, from, to) {
    var idx = findRow(rows, label, from);
    if (idx < 0 || (to != null && idx >= to)) return null;
    return toNumber(rows[idx][1]);
  }

  function readText(rows, label, from, to) {
    var idx = findRow(rows, label, from);
    if (idx < 0 || (to != null && idx >= to)) return null;
    var v = rows[idx][1];
    return v == null ? null : String(v).trim();
  }

  /**
   * Parse an ArrayBuffer (xlsx file contents) into a structured object:
   *
   *   {
   *     companyName, currentPrice, marketCap, numShares, faceValue,
   *     annualColumns: [{index, label}, ...],
   *     annual: {
   *       netProfit:          [nums...],
   *       depreciation:       [nums...],
   *       tax:                [nums...],
   *       cfo:                [nums...],
   *       cfi:                [nums...],
   *       cff:                [nums...],
   *       netCashFlow:        [nums...],
   *       borrowings:         [nums...],
   *       cashAndBank:        [nums...],
   *     }
   *   }
   *
   * Throws Error if the file clearly doesn't look like a Screener export.
   */
  function parse(arrayBuffer) {
    var rows = sheetToRows(arrayBuffer);
    if (!rows || rows.length < 10) {
      throw new Error("File looks empty or is not a Screener.in export.");
    }

    // --- Section boundaries -----------------------------------------------
    var metaStart   = findRow(rows, "META", 0);
    var plStart     = findRow(rows, "PROFIT & LOSS", metaStart >= 0 ? metaStart : 0);
    var qtrStart    = findRow(rows, "Quarters", plStart >= 0 ? plStart : 0);
    var bsStart     = findRow(rows, "BALANCE SHEET", qtrStart >= 0 ? qtrStart : 0);
    var cfStart     = findRow(rows, "CASH FLOW", bsStart >= 0 ? bsStart : 0);

    if (plStart < 0 || bsStart < 0 || cfStart < 0) {
      throw new Error(
        "This doesn't look like a Screener.in export — missing " +
        "PROFIT & LOSS, BALANCE SHEET or CASH FLOW section."
      );
    }

    var plEnd = qtrStart > 0 ? qtrStart : bsStart;
    var bsEnd = cfStart;
    var cfEnd = rows.length;

    // --- Company / META ---------------------------------------------------
    var companyName = readText(rows, "COMPANY NAME", 0, metaStart >= 0 ? metaStart : plStart);

    var metaFrom = metaStart >= 0 ? metaStart : 0;
    var metaTo = plStart;
    var numShares    = readScalar(rows, "Number of shares",    metaFrom, metaTo);
    var faceValue    = readScalar(rows, "Face value",          metaFrom, metaTo);
    var currentPrice = readScalar(rows, "Current Price",       metaFrom, metaTo);
    var marketCap    = readScalar(rows, "Market Capitalization", metaFrom, metaTo);

    if (currentPrice == null || marketCap == null) {
      throw new Error(
        "Missing Current Price or Market Capitalization in the META block."
      );
    }

    // --- P&L annual columns ----------------------------------------------
    var plHeaderIdx = findRow(rows, "Report Date", plStart, plEnd);
    if (plHeaderIdx < 0) {
      throw new Error("Could not find 'Report Date' row in PROFIT & LOSS section.");
    }
    var annualColumns = extractColumns(rows[plHeaderIdx]);
    if (annualColumns.length === 0) {
      throw new Error("No annual columns found in PROFIT & LOSS section.");
    }

    var netProfitIdx    = findRow(rows, "Net profit",   plHeaderIdx, plEnd);
    var depreciationIdx = findRow(rows, "Depreciation", plHeaderIdx, plEnd);
    var taxIdx          = findRowExact(rows, "Tax",     plHeaderIdx, plEnd);

    // --- Cash flow --------------------------------------------------------
    var cfHeaderIdx = findRow(rows, "Report Date", cfStart, cfEnd);
    if (cfHeaderIdx < 0) {
      throw new Error("Could not find 'Report Date' row in CASH FLOW section.");
    }
    var cfCols = extractColumns(rows[cfHeaderIdx]);
    // Cash flow should match the annual columns. If the column counts differ,
    // align by intersection of labels.
    var alignedCfCols = alignColumns(annualColumns, cfCols);

    var cfoIdx   = findRow(rows, "Cash from Operating Activity", cfHeaderIdx, cfEnd);
    var cfiIdx   = findRow(rows, "Cash from Investing Activity", cfHeaderIdx, cfEnd);
    var cffIdx   = findRow(rows, "Cash from Financing Activity", cfHeaderIdx, cfEnd);
    var netCfIdx = findRow(rows, "Net Cash Flow",                cfHeaderIdx, cfEnd);

    // --- Balance sheet ----------------------------------------------------
    var bsHeaderIdx = findRow(rows, "Report Date", bsStart, bsEnd);
    var borrowingsIdx = -1, cashBankIdx = -1;
    var alignedBsCols = [];
    if (bsHeaderIdx >= 0) {
      var bsCols = extractColumns(rows[bsHeaderIdx]);
      alignedBsCols = alignColumns(annualColumns, bsCols);
      borrowingsIdx = findRow(rows, "Borrowings", bsHeaderIdx, bsEnd);
      cashBankIdx   = findRow(rows, "Cash & Bank", bsHeaderIdx, bsEnd);
    }

    // Read series aligned to annualColumns (so array positions always match).
    var result = {
      companyName: companyName || "—",
      currentPrice: currentPrice,
      marketCap: marketCap,
      numShares: numShares,
      faceValue: faceValue,
      annualColumns: annualColumns,
      annual: {
        netProfit:    readSeries(rows, netProfitIdx,    annualColumns),
        depreciation: readSeries(rows, depreciationIdx, annualColumns),
        tax:          readSeries(rows, taxIdx,          annualColumns),
        cfo:          readAligned(rows, cfoIdx,   alignedCfCols, annualColumns),
        cfi:          readAligned(rows, cfiIdx,   alignedCfCols, annualColumns),
        cff:          readAligned(rows, cffIdx,   alignedCfCols, annualColumns),
        netCashFlow:  readAligned(rows, netCfIdx, alignedCfCols, annualColumns),
        borrowings:   readAligned(rows, borrowingsIdx, alignedBsCols, annualColumns),
        cashAndBank:  readAligned(rows, cashBankIdx,   alignedBsCols, annualColumns),
      },
    };

    return result;
  }

  // Build a parallel array the same length as `targetCols`, where each
  // entry is either the matching column from `sourceCols` (by label) or null.
  function alignColumns(targetCols, sourceCols) {
    var byLabel = {};
    sourceCols.forEach(function (c) { byLabel[c.label] = c; });
    return targetCols.map(function (t) {
      return byLabel[t.label] || null;
    });
  }

  // Read a row from `rowIdx` using the aligned column list, returning an
  // array parallel to `targetCols`.
  function readAligned(rows, rowIdx, alignedCols, targetCols) {
    if (rowIdx < 0) return targetCols.map(function () { return null; });
    var row = rows[rowIdx] || [];
    return alignedCols.map(function (c) {
      if (!c) return null;
      return toNumber(row[c.index]);
    });
  }

  return { parse: parse };
})();
