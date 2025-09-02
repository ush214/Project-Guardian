(function () {
  const root = document.documentElement;
  const stored = localStorage.getItem('pg-theme');
  const preferred = stored || 'light';
  root.setAttribute('data-theme', preferred);

  function apply(next) {
    root.setAttribute('data-theme', next);
    localStorage.setItem('pg-theme', next);
    const btn = document.getElementById('themeToggle');
    if (btn) btn.textContent = next === 'dark' ? '☀️' : '🌙';
  }

  window.toggleTheme = function () {
    const current = root.getAttribute('data-theme') || 'light';
    apply(current === 'light' ? 'dark' : 'light');
  };

  // Initialize button label on DOM ready
  window.addEventListener('DOMContentLoaded', () => {
    const current = root.getAttribute('data-theme') || 'light';
    apply(current);
  });
})();