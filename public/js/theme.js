// Applied before first paint to avoid a flash of the wrong theme.
(function () {
  var t = localStorage.getItem('allnote-theme');
  if (!t) t = window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.dataset.theme = t;
})();
