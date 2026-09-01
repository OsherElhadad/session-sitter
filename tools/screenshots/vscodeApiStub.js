// The webview API, stubbed for the screenshot harness.
//
// main.js calls acquireVsCodeApi() at load and then talks to the extension host only through
// postMessage. Providing that one function is the whole reason the real main.js can run unmodified
// in a browser: no copy, no fork, no "screenshot-only" build of the panel.
//
// The stub also answers the one request that the panel needs a reply to in order to render —
// getSessionPreview — from the synthetic previews the capture script installs on
// window.__ssHarnessPreviews. Everything else is recorded on window.__ssHarnessSent so the capture
// can assert the panel really did talk to its host.
(function () {
  'use strict';

  window.__ssHarnessSent = [];
  window.__ssHarnessPreviews = window.__ssHarnessPreviews || {};

  window.acquireVsCodeApi = function () {
    return {
      postMessage: function (message) {
        window.__ssHarnessSent.push(message);
        if (message && message.type === 'getSessionPreview') {
          var preview = window.__ssHarnessPreviews[message.sessionId] || { projectPath: '', exchanges: [] };
          // Same shape the provider posts back, and asynchronously like the real host.
          setTimeout(function () {
            window.postMessage({
              type: 'sessionPreview',
              sessionId: message.sessionId,
              projectPath: preview.projectPath,
              exchanges: preview.exchanges,
            }, '*');
          }, 0);
        }
      },
      getState: function () { return undefined; },
      setState: function () {},
    };
  };
}());
