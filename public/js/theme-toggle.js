(() => {
    const toggleBtn = document.getElementById('theme-toggle');
    const icon = document.getElementById('theme-icon');
    const html = document.documentElement;

    const getStoredTheme = () => localStorage.getItem('theme');
    const setStoredTheme = (theme) => localStorage.setItem('theme', theme);

    const applyTheme = (theme) => {
        const isDark = theme === 'dark';
        html.classList.toggle('dark', isDark);
        if (icon) {
            icon.className = isDark ? 'bi bi-sun fs-5' : 'bi bi-moon-stars fs-5';
        }
    };

    const initTheme = () => {
        const stored = getStoredTheme();
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        const theme = stored || (prefersDark ? 'dark' : 'light');
        applyTheme(theme);
    };

    if (toggleBtn) {
        toggleBtn.addEventListener('click', () => {
            const isCurrentlyDark = html.classList.contains('dark');
            const newTheme = isCurrentlyDark ? 'light' : 'dark';
            setStoredTheme(newTheme);
            applyTheme(newTheme);
        });
    }

    initTheme();
})();
