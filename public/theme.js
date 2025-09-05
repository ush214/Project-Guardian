(function() {
  const root = document.documentElement;
  const saved = localStorage.getItem("pg-theme");
  if (saved) root.setAttribute("data-theme", saved);

  window.toggleTheme = function() {
    const cur = root.getAttribute("data-theme") || "light";
    const next = cur === "light" ? "dark" : "light";
    root.setAttribute("data-theme", next);
    localStorage.setItem("pg-theme", next);
  };
})();