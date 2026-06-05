/**
 * Noteback — popup.js  (toolbar popup logic)
 *
 * Wires the popup buttons to the active tab's content script / the service
 * worker, renders the file-URL onboarding card, and drives the Save dropdown.
 */
'use strict';

document.addEventListener('DOMContentLoaded', function () {
  const byId = function (id) { return document.getElementById(id); };

  const btnToggle = byId('nb-toggle-sidebar');
  const btnCopy = byId('nb-copy-markdown');
  const saveBtn = byId('nb-save-btn');
  const saveMenu = byId('nb-save-menu');
  const onboardingEl = byId('nb-onboarding');
  const statusEl = byId('nb-status');

  let activeTab = null;

  init();

  function init() {
    getActiveTab()
      .then(function (tab) { activeTab = tab; return refreshState(tab); })
      .catch(function () {
        setStatus('Open a local HTML document to start annotating.');
        disableActions(true);
      });

    btnToggle.addEventListener('click', function () {
      runAction('NOTEBACK_TOGGLE_SIDEBAR', 'Toggling sidebar…', function () { window.close(); });
    });

    btnCopy.addEventListener('click', function () {
      runAction('NOTEBACK_COPY_MARKDOWN', 'Copying Markdown…', function (resp) {
        setStatus(resp && resp.ok ? 'Copied feedback as Markdown.' : 'Copy failed.');
      }, /*keepOpen*/ true);
    });

    saveBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (saveMenu.hasAttribute('hidden')) openSaveMenu(); else closeSaveMenu();
    });
    saveMenu.addEventListener('click', function (e) {
      const item = e.target.closest('[data-save]');
      if (!item) return;
      closeSaveMenu();
      doSave(item.getAttribute('data-save'));
    });
    document.addEventListener('click', function () { closeSaveMenu(); });
  }

  /* --- save dropdown ----------------------------------------------------- */

  function openSaveMenu() { saveMenu.removeAttribute('hidden'); saveBtn.setAttribute('aria-expanded', 'true'); }
  function closeSaveMenu() { saveMenu.setAttribute('hidden', ''); saveBtn.setAttribute('aria-expanded', 'false'); }

  function doSave(kind) {
    const map = {
      comments: { type: 'NOTEBACK_SAVE_CANVAS', pending: 'Saving HTML with comments…' },
      clean: { type: 'NOTEBACK_SAVE_CLEAN', pending: 'Saving clean HTML…' },
      pdf: { type: 'NOTEBACK_SAVE_PDF', pending: 'Opening print…' }
    };
    const m = map[kind];
    if (!m) return;
    runAction(m.type, m.pending, function (resp) {
      setStatus(resp && resp.ok ? m.pending : 'Save failed.');
      if (resp && resp.ok && kind !== 'pdf') setTimeout(function () { window.close(); }, 600);
    }, /*keepOpen*/ true);
  }

  /* --- state ------------------------------------------------------------- */

  function refreshState(tab) {
    const url = (tab && tab.url) || '';
    const isFile = /^file:\/\//i.test(url);
    const isLocalHttp = /^https?:\/\/(localhost|127\.0\.0\.1)([:/]|$)/i.test(url);
    if (!(isFile || isLocalHttp)) {
      setStatus('Noteback works on local file:// and localhost documents.');
      disableActions(true);
      return Promise.resolve();
    }
    return ping(tab.id).then(function (pong) {
      if (pong && pong.booted) {
        disableActions(false);
        setStatus(countLabel(pong));
        hideOnboarding();
        return;
      }
      return handleNotBooted(isFile);
    }).catch(function () { return handleNotBooted(isFile); });
  }

  function handleNotBooted(isFile) {
    if (isFile) {
      return checkFileAccess().then(function (allowed) {
        if (!allowed) {
          showOnboarding();
          disableActions(true);
          setStatus('Action needed to annotate local files.');
        } else {
          disableActions(true);
          setStatus('Reload the page, then reopen Noteback.');
        }
      });
    }
    disableActions(true);
    setStatus('Reload the page, then reopen Noteback.');
    return Promise.resolve();
  }

  function countLabel(pong) {
    const title = (pong && pong.docTitle) || 'document';
    return 'Ready on “' + truncate(title, 28) + '”.';
  }

  /* --- actions ----------------------------------------------------------- */

  function runAction(type, pending, onDone, keepOpen) {
    if (!activeTab || activeTab.id == null) { setStatus('No active document.'); return; }
    setStatus(pending);
    sendToTab(activeTab.id, { type: type }).then(
      function (resp) { if (typeof onDone === 'function') onDone(resp); void keepOpen; },
      function (err) { setStatus('Could not reach the page. Reload and try again.'); void err; }
    );
  }

  function disableActions(disabled) {
    [btnToggle, btnCopy, saveBtn].forEach(function (b) { if (b) b.disabled = !!disabled; });
    if (disabled) closeSaveMenu();
  }

  /* --- onboarding card --------------------------------------------------- */

  function showOnboarding() {
    onboardingEl.hidden = false;
    onboardingEl.innerHTML =
      '<div class="nb-card">' +
      '  <div class="nb-card__title">Allow access to file URLs</div>' +
      '  <p class="nb-card__lead">To annotate local <code>file://</code> documents,' +
      '   enable Noteback on its extension details page:</p>' +
      '  <ol class="nb-card__steps">' +
      '    <li>Open the extension details page (button below).</li>' +
      '    <li>Turn on <strong>“Allow access to file URLs.”</strong></li>' +
      '    <li>Reload your document tab.</li>' +
      '  </ol>' +
      '  <button id="nb-open-details" type="button" class="nb-btn nb-btn--primary">' +
      '    Open extension details' +
      '  </button>' +
      '  <p class="nb-card__note">Serving docs from <code>localhost</code> or' +
      '   <code>127.0.0.1</code> needs no toggle.</p>' +
      '</div>';
    const openBtn = document.getElementById('nb-open-details');
    if (openBtn) {
      openBtn.addEventListener('click', function () {
        sendToWorker({ type: 'NOTEBACK_OPEN_EXTENSION_DETAILS' }).then(
          function () { window.close(); },
          function () { setStatus('Could not open the details page.'); }
        );
      });
    }
  }

  function hideOnboarding() { onboardingEl.hidden = true; onboardingEl.innerHTML = ''; }

  /* --- messaging --------------------------------------------------------- */

  function ping(tabId) { return sendToTab(tabId, { type: 'NOTEBACK_PING' }); }

  function checkFileAccess() {
    return sendToWorker({ type: 'NOTEBACK_CHECK_FILE_ACCESS' })
      .then(function (resp) { return !!(resp && resp.allowed); })
      .catch(function () { return false; });
  }

  function getActiveTab() {
    return new Promise(function (resolve, reject) {
      chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        const err = chrome.runtime && chrome.runtime.lastError;
        if (err) { reject(new Error(err.message || String(err))); return; }
        const tab = tabs && tabs[0];
        if (!tab) { reject(new Error('no active tab')); return; }
        resolve(tab);
      });
    });
  }

  function sendToTab(tabId, message) {
    return new Promise(function (resolve, reject) {
      try {
        chrome.tabs.sendMessage(tabId, message, function (resp) {
          const err = chrome.runtime && chrome.runtime.lastError;
          if (err) { reject(new Error(err.message || String(err))); return; }
          resolve(resp);
        });
      } catch (e) { reject(e); }
    });
  }

  function sendToWorker(message) {
    return new Promise(function (resolve, reject) {
      try {
        chrome.runtime.sendMessage(message, function (resp) {
          const err = chrome.runtime && chrome.runtime.lastError;
          if (err) { reject(new Error(err.message || String(err))); return; }
          resolve(resp);
        });
      } catch (e) { reject(e); }
    });
  }

  /* --- misc -------------------------------------------------------------- */

  function setStatus(text) { if (statusEl) statusEl.textContent = text || ''; }
  function truncate(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
});
