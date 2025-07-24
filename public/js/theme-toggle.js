(() => {
  const toggleBtn = document.getElementById('theme-toggle');
  const icon = document.getElementById('theme-icon');
  const html = document.documentElement;

  const getStoredTheme = () => localStorage.getItem('theme');
  const setStoredTheme = (theme) => localStorage.setItem('theme', theme);

  const applyTheme = (theme) => {
    if (theme === 'dark') {
      html.classList.add('dark');
      icon.className = 'bi bi-sun fs-5';
    } else {
      html.classList.remove('dark');
      icon.className = 'bi bi-moon-stars fs-5';
    }
  };

  const toggleTheme = () => {
    const isDark = html.classList.contains('dark');
    const newTheme = isDark ? 'light' : 'dark';
    setStoredTheme(newTheme);
    applyTheme(newTheme);
  };

  const initTheme = () => {
    const stored = getStoredTheme();
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const theme = stored || (prefersDark ? 'dark' : 'light');
    applyTheme(theme);
  };

  if (toggleBtn) {
    toggleBtn.addEventListener('click', toggleTheme);
  }

  initTheme();
})();
