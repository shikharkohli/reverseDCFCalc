/* ============================================================
   theme.js — light/dark mode toggle persisted in localStorage.
   ============================================================ */
(function () {
  "use strict";

  var STORAGE_KEY = "reverseDCF.theme";
  var root = document.documentElement;

  function currentTheme() {
    return root.getAttribute("data-theme") || "light";
  }

  function applyTheme(theme) {
    root.setAttribute("data-theme", theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch (e) {
      /* localStorage blocked — ignore */
    }
  }

  function initialTheme() {
    try {
      var stored = localStorage.getItem(STORAGE_KEY);
      if (stored === "light" || stored === "dark") return stored;
    } catch (e) {
      /* ignore */
    }
    if (
      window.matchMedia &&
      window.matchMedia("(prefers-color-scheme: dark)").matches
    ) {
      return "dark";
    }
    return "light";
  }

  // Apply before the rest of the UI paints to avoid a flash.
  applyTheme(initialTheme());

  document.addEventListener("DOMContentLoaded", function () {
    var btn = document.getElementById("theme-toggle");
    if (!btn) return;
    btn.addEventListener("click", function () {
      applyTheme(currentTheme() === "dark" ? "light" : "dark");
    });
  });
})();
