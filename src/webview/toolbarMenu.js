// Toolbar hamburger menu + about box for the Session Sitter webview.
// Loaded as its own classic <script> before main.js. It only DEFINES a factory
// on window and does nothing until init() is called — main.js owns the single
// acquireVsCodeApi() and passes in a postMessage function.
(function () {
  'use strict';

  /**
   * Keyboard behaviour shared by every dropdown in the panel: Up/Down/Home/End move between the
   * items, Escape closes the menu and puts focus back on the button that opened it — without that
   * last part, dismissing a menu drops the keyboard user at the top of the document.
   *
   * Exported because the sort picker in main.js needs exactly the same behaviour, and two menus
   * with two implementations is how one of them ends up missing a key.
   * @param {HTMLElement} menu
   * @param {HTMLElement | null} trigger — the button that opened it, refocused on Escape
   * @param {() => void} close
   */
  function wireMenuKeys(menu, trigger, close) {
    menu.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        if (trigger) { trigger.focus(); }
        return;
      }
      const items = Array.prototype.slice.call(
        menu.querySelectorAll('.session-context-menu-item'));
      const here = items.indexOf(document.activeElement);
      let next = -1;
      // A menu wraps, unlike the session list: there is nothing past either end of it.
      if (event.key === 'ArrowDown') { next = here + 1 >= items.length ? 0 : here + 1; }
      else if (event.key === 'ArrowUp') { next = here <= 0 ? items.length - 1 : here - 1; }
      else if (event.key === 'Home') { next = 0; }
      else if (event.key === 'End') { next = items.length - 1; }
      else { return; }
      event.preventDefault();
      if (items[next]) { items[next].focus(); }
    });
  }

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

    /** @type {HTMLElement | null} — what had focus when the about box opened, restored on close */
    let aboutOpener = null;

    function closeMenu() {
      if (menuEl) { menuEl.remove(); menuEl = null; }
      if (menuBtn) { menuBtn.setAttribute('aria-expanded', 'false'); }
    }

    // The about box is a modal: focus moves into it, stays there while it is open, and goes back
    // where it came from on close. Without that, the dialog is announced as nothing and Tab walks
    // straight out of it into the list behind.
    function openAbout() {
      if (!aboutBox) { return; }
      // Opened from the ☰ menu, the focused element is a menu item that is about to be removed, so
      // focus has to come back to the button that owns the menu, not to a detached node.
      aboutOpener = menuEl ? menuBtn : document.activeElement;
      aboutBox.hidden = false;
      if (aboutClose) { aboutClose.focus(); }
    }

    function closeAbout() {
      if (!aboutBox || aboutBox.hidden) { return; }
      aboutBox.hidden = true;
      if (aboutOpener && aboutOpener.focus) { aboutOpener.focus(); }
      aboutOpener = null;
    }

    function openMenu() {
      closeMenu();
      const menu = document.createElement('div');
      menu.className = 'session-context-menu';
      menu.setAttribute('role', 'menu');

      const items = [
        { label: 'About', run: openAbout },
        {
          label: 'All settings…',
          run: function () { deps.postMessage({ type: 'openSettings' }); },
        },
        {
          label: 'Auto-respond rules…',
          run: function () {
            deps.postMessage({ type: 'openSettings', query: 'sessionSitter.autoRespond' });
          },
        },
        {
          label: 'Supervisor settings…',
          run: function () {
            deps.postMessage({ type: 'openSettings', query: 'sessionSitter.supervisor' });
          },
        },
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
      if (menuBtn) { menuBtn.setAttribute('aria-expanded', 'true'); }
      wireMenuKeys(menu, menuBtn, closeMenu);

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
      aboutClose.addEventListener('click', closeAbout);
    }

    if (aboutBox) {
      aboutBox.addEventListener('keydown', function (event) {
        if (event.key === 'Escape') { event.preventDefault(); closeAbout(); return; }
        // The dialog holds exactly one focusable control, so trapping focus is keeping Tab on it.
        if (event.key === 'Tab') {
          event.preventDefault();
          if (aboutClose) { aboutClose.focus(); }
        }
      });
    }

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        if (menuEl) { closeMenu(); if (menuBtn) { menuBtn.focus(); } }
        closeAbout();
      }
    });

    document.addEventListener('mousedown', function (event) {
      if (menuEl && !menuEl.contains(event.target) && event.target !== menuBtn) {
        closeMenu();
      }
    });
  }

  window.SessionSitterMenu = { init: init, wireMenuKeys: wireMenuKeys };
}());
