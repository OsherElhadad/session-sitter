// Toolbar hamburger menu + about box for the AI Sessions webview.
// Loaded as its own classic <script> before main.js. It only DEFINES a factory
// on window and does nothing until init() is called — main.js owns the single
// acquireVsCodeApi() and passes in a postMessage function.
(function () {
  'use strict';

  /**
   * Wire the hamburger menu (#menu-btn), its dropdown, and the about box.
   * @param {{ postMessage: (msg: unknown) => void }} deps
   */
  function init(deps) {
    const menuBtn = document.getElementById('menu-btn');
    const aboutBox = document.getElementById('about-box');
    const aboutClose = document.getElementById('about-close');

    /** @type {HTMLElement | null} */
    let menuEl = null;

    function closeMenu() {
      if (menuEl) { menuEl.remove(); menuEl = null; }
    }

    function openMenu() {
      closeMenu();
      const menu = document.createElement('div');
      menu.className = 'session-context-menu';
      menu.setAttribute('role', 'menu');

      const items = [
        { label: 'About', run: function () { if (aboutBox) { aboutBox.hidden = false; } } },
        { label: 'Settings…', run: function () { deps.postMessage({ type: 'openSettings' }); } },
      ];
      items.forEach(function (item) {
        const btn = document.createElement('button');
        btn.className = 'session-context-menu-item';
        btn.setAttribute('role', 'menuitem');
        btn.textContent = item.label;
        btn.addEventListener('click', function () { item.run(); closeMenu(); });
        menu.appendChild(btn);
      });

      document.body.appendChild(menu);
      menuEl = menu;

      // Anchor under the button (menu is position: fixed).
      const rect = menuBtn.getBoundingClientRect();
      const width = menu.getBoundingClientRect().width;
      const left = Math.min(rect.left, window.innerWidth - width - 4);
      menu.style.left = Math.max(4, left) + 'px';
      menu.style.top = rect.bottom + 'px';

      const first = menu.querySelector('.session-context-menu-item');
      if (first) { first.focus(); }
    }

    if (menuBtn) {
      menuBtn.addEventListener('click', function (event) {
        event.stopPropagation();
        if (menuEl) { closeMenu(); } else { openMenu(); }
      });
    }

    if (aboutClose) {
      aboutClose.addEventListener('click', function () {
        if (aboutBox) { aboutBox.hidden = true; }
      });
    }

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        closeMenu();
        if (aboutBox && !aboutBox.hidden) { aboutBox.hidden = true; }
      }
    });

    document.addEventListener('mousedown', function (event) {
      if (menuEl && !menuEl.contains(event.target) && event.target !== menuBtn) {
        closeMenu();
      }
    });
  }

  window.SessionSwitcherMenu = { init: init };
}());
