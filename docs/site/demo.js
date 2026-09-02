/* ===========================================================================
   The demo terminal, plus the two ten-line helpers that had no better home
   (copy-to-clipboard, the theme toggle). No dependencies, no build step.

   A scene is an ordered list of frames. A frame either APPENDS lines to a
   growing transcript, TYPES one line character by character, or animates a
   COUNTER in the line it just appended. Every line is <= 56 characters, so the
   panel never scrolls sideways.

   Every latency in these scenes is a measured number, not a prop:
   the deterministic PermissionRequest round trip is 3-4 ms end to end, so the
   counter stops at 4 and `latency_ms` in the record is 4.
   =========================================================================== */
(function () {
  'use strict';

  var B = ['', ''];                                    // a blank line
  function clock(s) { return ('0' + Math.floor(s / 60)).slice(-2) + ':' + ('0' + (s % 60)).slice(-2); }

  var SCENES = {
    a: {
      label: 'A force-push, corrected',
      frames: [
        { caption: '02:14 · nobody is watching', hold: 1000, lines: [
          ['dim', '~/w/payments-api  release/2.4  ·  claude code'] ] },
        { caption: 'the last instruction of the night', hold: 700, lines: [B],
          type: { pre: '> ', cls: 'fg', text: 'ship the retry-backoff fix to the release branch', ms: 18 } },
        { caption: 'the agent proposes a tool call', hold: 1200, lines: [B,
          ['fg', '● Bash(git push --force origin release/2.4)'],
          ['dim', '  dropping the reverted commit from the branch'] ] },
        { caption: 'Claude Code would stop here and ask you', hold: 1400, lines: [B,
          ['dim', '⟳ session-sitter · PermissionRequest'] ],
          counter: { cls: 'dim', tpl: '  deterministic tier · no model call · # ms',
                     values: [0, 1, 2, 3, 4], ms: 500 } },
        { caption: 'the clause that applied, by name', hold: 2600, lines: [B,
          ['yellow', '🟡 corrected — practices §4'],
          ['fg', '   "Never force-push a shared branch. Use'],
          ['fg', '    --force-with-lease, so a concurrent push'],
          ['fg', '    fails loudly instead of being overwritten."'],
          ['dim', '   team/bottom-line.md · team-git-004 · high'] ] },
        { caption: 'the call is rewritten, not blocked', hold: 2200, lines: [B,
          ['dim', '  decision.updatedInput'],
          ['del', '- git push --force origin release/2.4'],
          ['add', '+ git push --force-with-lease origin release/2.4'],
          ['dim', '  re-checked against your deny rules · allowed'] ] },
        { caption: 'the run continues', hold: 1600, lines: [B,
          ['dim', 'To github.com:acme/payments-api.git'],
          ['dim', ' + 9f1c2ad...4b7e0d1 release/2.4 -> release/2.4'],
          ['green', '✓ Bash completed · no human was woken'] ] },
        { caption: 'one durable record, written at the time', hold: 2800, lines: [B,
          ['dim', '$ tail -1 ~/.session-sitter/audit.jsonl'],
          ['fg', '{"request_id":"req-8f3c1a","state":"yellow_delivered",'],
          ['fg', ' "session_name":"payments-api","host":"nomad",'],
          ['fg', ' "source":"claude-code","decided_by":"rule",'],
          ['fg', ' "clause":"team-git-004","tool":"Bash","latency_ms":4,'],
          ['fg', ' "from":"git push --force origin release/2.4",'],
          ['fg', ' "to":"git push --force-with-lease origin release/2.4",'],
          ['fg', ' "at":"2026-09-02T02:14:37Z"}'] ] },
        { caption: 'and it is queryable in the morning', hold: 3000, lines: [B,
          ['dim', '$ session-sitter log --since 22:00 --corrected'],
          ['yellow', '02:14  corrected  §4  --force → --force-with-lease'],
          ['yellow', '03:02  corrected  §7  rm -rf → git clean -nd'],
          ['red', '04:41  denied     §2  Write .github/workflows/'],
          ['dim', '3 decisions · 2 corrected · 1 denied · 0 escalated'] ] },
        { caption: 'Silence is never approval.', hold: 0, lines: [B,
          ['mint', 'Silence is never approval.'] ] }
      ]
    },
    b: {
      label: 'Nobody answered',
      frames: [
        { caption: '03:58 · a genuine judgment call', hold: 900, lines: [
          ['dim', '~/w/payments-api  release/2.4  ·  claude code'], B,
          ['fg', '● Bash(gh release create v2.4.0 --latest)'],
          ['dim', '  publishing the release the fix went into'] ] },
        { caption: 'no clause covers it — so it is your call', hold: 1300, lines: [B,
          ['dim', '⟳ session-sitter · PermissionRequest'],
          ['orange', '🟠 escalated — no clause covers a public release'],
          ['dim', '   decision card sent · nomad · replies to you'] ] },
        { caption: 'the countdown is compressed for this demo', hold: 3600, lines: [B],
          counter: { cls: 'orange', tpl: '   waiting on you   #', ms: 3500,
                     values: (function () { var v = [], i; for (i = 24; i >= 0; i--) { v.push(clock(i * 37.5 | 0)); } return v; })() },
          after: [ ['dim', '   Approve · Deny · Deny and tell it why'] ] },
        { caption: 'the timeout is a denial, never an approval', hold: 2800, lines: [B,
          ['red', '🔴 denied — timeout · 15:00 elapsed, no answer'],
          ['fg', '   the agent was handed the alternatives:'],
          ['dim', '    · open a draft release and stop'],
          ['dim', '    · wait for a human at 09:00'],
          ['green', '✓ the run continued on the safe path'] ] },
        { caption: 'Silence is never approval.', hold: 0, lines: [B,
          ['mint', 'An unanswered card denies. It never approves.'] ] }
      ]
    }
  };

  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function line(cls, text, pre) {
    var d = document.createElement('div');
    if (pre) {
      var p = document.createElement('span');
      p.className = 'mint'; p.textContent = pre; d.appendChild(p);
    }
    var s = document.createElement('span');
    s.className = cls; s.textContent = text; d.appendChild(s);
    return d;
  }

  /** One terminal. `root` carries data-scenes, and optionally data-autoplay. */
  function Player(root) {
    var pre = root.querySelector('[data-term]');
    var captionEl = root.querySelector('[data-caption]');
    var tablist = root.querySelector('[data-tabs]');
    var dotsEl = root.querySelector('[data-dots]');
    var replayEl = root.querySelector('[data-replay]');
    var transcript = root.querySelector('[data-transcript]');
    var names = (root.dataset.scenes || 'a').split(',');
    var scene = names[0], frame = -1, playing = false, timers = [], staticScene = null;

    if (transcript) { transcript.open = false; }   // JS is here, so collapse it

    function frames() { return SCENES[scene].frames; }
    function clear() { timers.forEach(clearTimeout); timers = []; playing = false; }
    function wipe() { while (pre.firstChild) { pre.removeChild(pre.firstChild); } }
    function bottom() { pre.scrollTop = pre.scrollHeight; }

    /** Append a frame's finished state. */
    function paint(f) {
      (f.lines || []).forEach(function (l) { pre.appendChild(line(l[0], l[1])); });
      if (f.type) { pre.appendChild(line(f.type.cls, f.type.text, f.type.pre)); }
      if (f.counter) {
        var v = f.counter.values[f.counter.values.length - 1];
        pre.appendChild(line(f.counter.cls, f.counter.tpl.replace('#', v)));
      }
      (f.after || []).forEach(function (l) { pre.appendChild(line(l[0], l[1])); });
    }

    function dots() {
      if (!dotsEl) { return; }
      while (dotsEl.firstChild) { dotsEl.removeChild(dotsEl.firstChild); }
      frames().forEach(function (f, i) {
        var b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('aria-label', 'Frame ' + (i + 1) + ' of ' + frames().length + ': ' + f.caption);
        if (i === frame) { b.setAttribute('aria-current', 'true'); }
        b.addEventListener('click', function () { goto(i); });
        dotsEl.appendChild(b);
      });
    }

    /** Jump to the end state of frame `i`, instantly. */
    function goto(i) {
      clear(); wipe();
      frame = Math.max(0, Math.min(i, frames().length - 1));
      for (var k = 0; k <= frame; k++) { paint(frames()[k]); }
      captionEl.textContent = frames()[frame].caption;
      dots(); bottom();
    }

    /** Play frame `i`, then schedule the next. */
    function step(i) {
      if (i >= frames().length) { playing = false; return; }
      frame = i; playing = true;
      var f = frames()[i];
      captionEl.textContent = f.caption;
      dots();
      (f.lines || []).forEach(function (l) { pre.appendChild(line(l[0], l[1])); });
      bottom();

      var next = function () { timers.push(setTimeout(function () { step(i + 1); }, f.hold || 0)); };

      if (f.type) {
        var el = line(f.type.cls, '', f.type.pre);
        var span = el.lastChild;
        var caret = document.createElement('span');
        caret.className = 'caret'; caret.textContent = '▋'; el.appendChild(caret);
        pre.appendChild(el); bottom();
        var n = 0;
        var tick = function () {
          span.textContent = f.type.text.slice(0, ++n);
          bottom();
          if (n < f.type.text.length) { timers.push(setTimeout(tick, f.type.ms)); }
          else { el.removeChild(caret); next(); }
        };
        timers.push(setTimeout(tick, f.type.ms));
        return;
      }

      if (f.counter) {
        var c = f.counter, el2 = line(c.cls, c.tpl.replace('#', c.values[0]));
        pre.appendChild(el2); bottom();
        var j = 0, per = Math.max(16, c.ms / c.values.length);
        var run = function () {
          el2.lastChild.textContent = c.tpl.replace('#', c.values[j]);
          if (++j < c.values.length) { timers.push(setTimeout(run, per)); }
          else { (f.after || []).forEach(function (l) { pre.appendChild(line(l[0], l[1])); }); bottom(); next(); }
        };
        timers.push(setTimeout(run, per));
        return;
      }
      next();
    }

    function play() { clear(); wipe(); step(0); }

    function select(name, focus) {
      scene = name;
      if (tablist) {
        tablist.querySelectorAll('[role="tab"]').forEach(function (t) {
          var on = t.dataset.scene === name;
          t.setAttribute('aria-selected', on ? 'true' : 'false');
          t.tabIndex = on ? 0 : -1;
          if (on) {
            if (focus) { t.focus(); }
            var panel = document.getElementById(t.getAttribute('aria-controls'));
            if (panel) { panel.setAttribute('aria-labelledby', t.id); }
          }
        });
      }
      if (reduced) { showStatic(name); } else { play(); }
    }

    /** Reduced motion: the whole scene at once, no animation at all. */
    function showStatic(name) {
      clear(); wipe(); scene = name; staticScene = name;
      frames().forEach(paint);
      frame = frames().length - 1;
      captionEl.textContent = 'Animation off — the full transcript is shown.';
      dots();
      if (replayEl && names.length > 1) {
        replayEl.textContent = name === 'a' ? 'Show the timeout case' : 'Show the correction';
      }
    }

    if (tablist) {
      tablist.addEventListener('click', function (e) {
        var t = e.target.closest('[role="tab"]');
        if (t) { select(t.dataset.scene, false); }
      });
      tablist.addEventListener('keydown', function (e) {
        var tabs = [].slice.call(tablist.querySelectorAll('[role="tab"]'));
        var i = tabs.indexOf(document.activeElement), to = -1;
        if (e.key === 'ArrowRight') { to = (i + 1) % tabs.length; }
        else if (e.key === 'ArrowLeft') { to = (i - 1 + tabs.length) % tabs.length; }
        else if (e.key === 'Home') { to = 0; }
        else if (e.key === 'End') { to = tabs.length - 1; }
        if (to >= 0) { e.preventDefault(); e.stopPropagation(); select(tabs[to].dataset.scene, true); }
      });
    }

    if (replayEl) {
      replayEl.addEventListener('click', function () {
        if (reduced && names.length > 1) { showStatic(staticScene === 'a' ? 'b' : 'a'); }
        else if (reduced) { showStatic(scene); }
        else { play(); }
      });
    }

    root.addEventListener('keydown', function (e) {
      if (reduced) { return; }
      if (e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        if (playing) { clear(); } else { step(frame < 0 ? 0 : frame + 1); }
      } else if (e.key === 'ArrowRight') { e.preventDefault(); goto(frame + 1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); goto(frame - 1); }
      else if (e.key === 'Home') { e.preventDefault(); play(); }
    });

    /* A hidden tab is a paused tab. Coming back does NOT auto-resume. */
    document.addEventListener('visibilitychange', function () { if (document.hidden) { clear(); } });

    if (reduced) { showStatic(scene); return; }

    goto(0);
    var auto = root.dataset.autoplay;
    if (auto && window.IntersectionObserver) {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (en.intersectionRatio >= 0.5) { io.disconnect(); select(auto, false); }
        });
      }, { threshold: [0.5] });
      io.observe(root);
    }

    /* The hero CTA restarts the demo rather than just jumping to it. */
    root.replayScene = function (name) { select(name || names[0], false); };
  }

  var players = {};
  document.querySelectorAll('[data-demo]').forEach(function (root) {
    Player(root);
    players[root.id] = root;
  });

  var cta = document.getElementById('cta-demo');
  if (cta) {
    cta.addEventListener('click', function () {
      var hero = players['demo'];
      if (hero && hero.replayScene) { hero.replayScene('a'); }
    });
  }

  /* --- copy to clipboard ------------------------------------------------- */
  document.querySelectorAll('[data-copy]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var text = document.getElementById(btn.dataset.copy).textContent;
      var done = function () {
        var was = btn.textContent;
        btn.textContent = 'Copied';
        setTimeout(function () { btn.textContent = was; }, 1600);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, fallback);
      } else { fallback(); }
      function fallback() {
        var ta = document.createElement('textarea');
        ta.value = text; ta.setAttribute('readonly', '');
        ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); done(); } catch (e) { /* nothing to do */ }
        document.body.removeChild(ta);
      }
    });
  });

  /* --- theme toggle: system -> light -> dark -> system -------------------- */
  var toggle = document.getElementById('theme-toggle');
  if (toggle) {
    var label = document.getElementById('theme-label');
    var order = ['system', 'light', 'dark'];
    var read = function () { try { return localStorage.getItem('ssTheme') || 'system'; } catch (e) { return 'system'; } };
    var show = function (v) {
      label.textContent = v.charAt(0).toUpperCase() + v.slice(1);
      toggle.setAttribute('aria-label', 'Theme: ' + v + '. Activate to change.');
      if (v === 'system') { delete document.documentElement.dataset.theme; }
      else { document.documentElement.dataset.theme = v; }
    };
    show(read());
    toggle.addEventListener('click', function () {
      var v = order[(order.indexOf(read()) + 1) % order.length];
      try { v === 'system' ? localStorage.removeItem('ssTheme') : localStorage.setItem('ssTheme', v); } catch (e) { /* private window */ }
      show(v);
    });
  }
})();
