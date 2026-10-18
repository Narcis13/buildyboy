// The manual's only script of its own, loaded in <head> so the theme is set before the first paint.
// Everything else here is progressive enhancement: the pages read fine without it.
(function () {
  var root = document.documentElement;
  try {
    var saved = localStorage.getItem('bb-theme'); // shared with the app's theme toggle
    if (saved === 'light' || saved === 'dark') root.dataset.theme = saved;
  } catch (e) {
    // storage blocked: keep the default
  }

  function themeButton() {
    var btn = document.querySelector('[data-docs="theme"]');
    if (!btn) return;
    var paint = function () {
      btn.textContent = root.dataset.theme === 'light' ? '☀' : '☾';
    };
    paint();
    btn.addEventListener('click', function () {
      root.dataset.theme = root.dataset.theme === 'light' ? 'dark' : 'light';
      try {
        localStorage.setItem('bb-theme', root.dataset.theme);
      } catch (e) {
        // ignore
      }
      paint();
    });
  }

  // "Copy" on every code block.
  function copyButtons() {
    document.querySelectorAll('[data-docs="article"] pre').forEach(function (pre) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.setAttribute('data-ui', 'button');
      btn.setAttribute('data-variant', 'ghost');
      btn.setAttribute('data-size', 'sm');
      btn.setAttribute('data-docs', 'copy');
      btn.textContent = 'Copy';
      btn.addEventListener('click', function () {
        var text = pre.innerText.replace(/\n$/, '');
        var done = function (label) {
          btn.textContent = label;
          setTimeout(function () {
            btn.textContent = 'Copy';
          }, 1400);
        };
        if (navigator.clipboard && window.isSecureContext) {
          navigator.clipboard.writeText(text).then(function () {
            done('Copied');
          }, function () {
            done('Press Ctrl+C');
          });
        } else {
          var range = document.createRange();
          range.selectNodeContents(pre);
          var sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          done('Selected');
        }
      });
      var wrap = document.createElement('div');
      wrap.setAttribute('data-docs', 'code');
      pre.parentNode.insertBefore(wrap, pre);
      wrap.appendChild(pre);
      wrap.appendChild(btn);
    });
  }

  // "On this page": the page's own h2s, with the one in view highlighted.
  function tableOfContents() {
    var toc = document.querySelector('[data-docs="toc"]');
    var heads = document.querySelectorAll('[data-docs="article"] h2[id]');
    if (!toc || heads.length < 2) return;
    var title = document.createElement('p');
    title.setAttribute('data-docs', 'nav-group');
    title.textContent = 'On this page';
    var list = document.createElement('nav');
    list.setAttribute('aria-label', 'Sections of this page');
    var links = [];
    heads.forEach(function (h) {
      var a = document.createElement('a');
      a.href = '#' + h.id;
      a.textContent = h.textContent;
      list.appendChild(a);
      links.push(a);
    });
    toc.appendChild(title);
    toc.appendChild(list);
    if (!('IntersectionObserver' in window)) return;
    var seen = new Map();
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        seen.set(e.target.id, e.isIntersecting);
      });
      var current = null;
      heads.forEach(function (h) {
        if (current === null && seen.get(h.id)) current = h.id;
      });
      if (current === null) return;
      links.forEach(function (a) {
        if (a.getAttribute('href') === '#' + current) a.setAttribute('aria-current', 'location');
        else a.removeAttribute('aria-current');
      });
    }, { rootMargin: '0px 0px -60% 0px' });
    heads.forEach(function (h) {
      io.observe(h);
    });
  }

  // Headings link to themselves, so a section can be shared.
  function headingAnchors() {
    document.querySelectorAll('[data-docs="article"] h2[id], [data-docs="article"] h3[id]').forEach(function (h) {
      var a = document.createElement('a');
      a.href = '#' + h.id;
      a.setAttribute('data-docs', 'anchor');
      a.setAttribute('aria-label', 'Link to this section');
      a.textContent = '#';
      h.appendChild(a);
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    themeButton();
    copyButtons();
    tableOfContents();
    headingAnchors();
  });
})();
