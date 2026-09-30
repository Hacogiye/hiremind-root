// Theme toggle: light mặc định, nhớ lựa chọn qua localStorage, tôn trọng hệ điều hành lần đầu.
(function () {
  const KEY = 'hiremind-theme';
  let theme = 'light';
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'dark' || saved === 'light') theme = saved;
    else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) theme = 'dark';
  } catch (e) { /* storage blocked — dùng light */ }
  apply(theme);

  function apply(t) {
    document.documentElement.setAttribute('data-theme', t);
    document.querySelectorAll('[data-theme-toggle]').forEach(btn => {
      btn.setAttribute('aria-label', t === 'dark' ? 'Chuyển sang giao diện sáng' : 'Chuyển sang giao diện tối');
      const iconSun = btn.querySelector('.icon-sun');
      const iconMoon = btn.querySelector('.icon-moon');
      if (iconSun && iconMoon) {
        iconSun.classList.toggle('hidden', t === 'dark');
        iconMoon.classList.toggle('hidden', t !== 'dark');
      }
    });
  }

  window.toggleTheme = function () {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem(KEY, next); } catch (e) { /* ignore */ }
    apply(next);
  };

  document.addEventListener('DOMContentLoaded', () => {
    apply(document.documentElement.getAttribute('data-theme') || theme);
    document.querySelectorAll('[data-theme-toggle]').forEach(btn => {
      btn.addEventListener('click', window.toggleTheme);
    });
  });
})();
