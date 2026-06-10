// Webview main script
// Runs inside the VS Code WebView panel — no build step, plain vanilla JS.

(function () {
  'use strict';

  // Acquire the VS Code API once and store it.
  const vscodeApi = acquireVsCodeApi();

  // ── State ────────────────────────────────────────────────────────────────

  /** @type {Array<{sessionId: string, projectName: string, title: string, updatedAt: string}>} */
  let sessions = [];
  let historyExpanded = false;

  // ── DOM References (populated after DOMContentLoaded) ───────────────────

  let tabStrip;        // the scrollable tab row (excluding the + button)
  let historyContent;  // the collapsible content div
  let historyToggle;   // the toggle button / heading

  // ── Helpers ──────────────────────────────────────────────────────────────

  /**
   * Format an ISO date string as a human-readable relative time string.
   * @param {string} isoString
   * @returns {string}
   */
  function formatRelativeTime(isoString) {
    const now = Date.now();
    const then = new Date(isoString).getTime();
    if (isNaN(then)) {
      return '';
    }
    const diffMs = now - then;
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHr  = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHr  / 24);

    if (diffSec < 60)  { return 'just now'; }
    if (diffMin < 60)  { return diffMin === 1 ? '1 minute ago' : `${diffMin} minutes ago`; }
    if (diffHr  < 24)  { return diffHr  === 1 ? '1 hour ago'   : `${diffHr} hours ago`; }
    if (diffDay < 30)  { return diffDay === 1 ? '1 day ago'    : `${diffDay} days ago`; }
    // Fall back to locale date for older items
    return new Date(isoString).toLocaleDateString();
  }

  // ── Render ───────────────────────────────────────────────────────────────

  /**
   * Build a single tab element for the tab strip.
   * @param {{sessionId: string, projectName: string, title: string}} session
   * @returns {HTMLElement}
   */
  function buildTab(session) {
    const tab = document.createElement('div');
    tab.className = 'tab';
    tab.dataset.sessionId = session.sessionId;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('tabindex', '0');
    tab.setAttribute('title', (session.title || '(untitled)') + ' — ' + formatRelativeTime(session.updatedAt));

    // Title label
    const titleEl = document.createElement('span');
    titleEl.className = 'tab-title';
    titleEl.textContent = session.title || '(untitled)';

    // Project badge
    const badgeEl = document.createElement('span');
    badgeEl.className = 'tab-badge';
    badgeEl.textContent = session.projectName || '';

    // Close button
    const closeBtn = document.createElement('button');
    closeBtn.className = 'tab-close';
    closeBtn.setAttribute('aria-label', 'Close tab');
    closeBtn.setAttribute('title', 'Close tab');
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      vscodeApi.postMessage({ type: 'removeTab', sessionId: session.sessionId });
    });

    tab.appendChild(titleEl);
    if (session.projectName) {
      tab.appendChild(badgeEl);
    }
    tab.appendChild(closeBtn);

    // Clicking the tab body (not the close button) switches to that session
    tab.addEventListener('click', () => {
      vscodeApi.postMessage({ type: 'switchSession', sessionId: session.sessionId });
    });

    // Keyboard accessibility: Enter/Space activates the tab
    tab.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        if (event.target === closeBtn) { return; } // Let close button handle its own click
        event.preventDefault();
        vscodeApi.postMessage({ type: 'switchSession', sessionId: session.sessionId });
      }
    });

    return tab;
  }

  /**
   * Fully re-render the tab strip from the current `sessions` array.
   */
  function renderTabs() {
    if (!tabStrip) { return; }
    // Clear existing tabs (everything except the + button, which is a sibling)
    tabStrip.innerHTML = '';

    if (sessions.length === 0) {
      const placeholder = document.createElement('span');
      placeholder.className = 'tab-placeholder';
      placeholder.textContent = 'No open sessions';
      tabStrip.appendChild(placeholder);
      return;
    }

    sessions.forEach((session) => {
      tabStrip.appendChild(buildTab(session));
    });
  }

  /**
   * Re-render the history section header count.
   * (Content is a static placeholder for v1.)
   */
  function renderHistory() {
    const countEl = document.getElementById('history-count');
    if (countEl) {
      countEl.textContent = '';
    }
  }

  /**
   * Full render pass.
   */
  function render() {
    renderTabs();
    renderHistory();
  }

  // ── History toggle ────────────────────────────────────────────────────────

  function toggleHistory() {
    historyExpanded = !historyExpanded;
    historyContent.hidden = !historyExpanded;
    historyToggle.setAttribute('aria-expanded', String(historyExpanded));
    const arrow = historyToggle.querySelector('.history-arrow');
    if (arrow) {
      arrow.textContent = historyExpanded ? '▼' : '▶';
    }
  }

  // ── Message handling ─────────────────────────────────────────────────────

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || typeof message !== 'object') {
      return;
    }

    switch (message.type) {
      case 'updateSessions':
        sessions = Array.isArray(message.sessions) ? message.sessions : [];
        render();
        break;
      default:
        // Ignore unknown message types
        break;
    }
  });

  // ── Initialization ───────────────────────────────────────────────────────

  function init() {
    tabStrip      = document.getElementById('tab-strip');
    historyContent = document.getElementById('history-content');
    historyToggle  = document.getElementById('history-toggle');

    // New session button
    const newBtn = document.getElementById('new-session-btn');
    if (newBtn) {
      newBtn.addEventListener('click', () => {
        vscodeApi.postMessage({ type: 'newSession' });
      });
    }

    // History collapse/expand
    if (historyToggle) {
      historyToggle.addEventListener('click', toggleHistory);
    }

    // Initial render (empty state)
    render();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}());
