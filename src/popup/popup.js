/**
 * Noteback — popup.js  (toolbar popup logic)
 *
 * Wires the popup buttons to the active tab's content script / the service
 * worker, and renders the onboarding card when "Allow access to file URLs" is
 * OFF on a file:// document (spec §9).
 *
 *   - Toggle sidebar    -> NOTEBACK_TOGGLE_SIDEBAR  (content script).
 *   - Copy as Markdown  -> NOTEBACK_COPY_MARKDOWN   (content script copies).
 *   - Save as HTML canvas -> NOTEBACK_SAVE_CANVAS   (content script -> worker).
 *
 * The content script may not be present on a file:// page when file-URL access
 * is disabled (it never injected); we detect that with a PING and show the
 * onboarding card instead of dead buttons.
 */

'use strict';

document.addEventListener('DOMContentLoaded', function () {
  const byId = function (id) { return document.getElementById(id); };

  const btnToggle = byId('nb-toggle-sidebar');
  const btnCopy = byId('nb-copy-markdown');
  const btnSave = byId('nb-save-canvas');
  const onboardingEl = byId('nb-onboarding');
  const statusEl = byId('nb-status');

  let activeTab = null;

  init();

  function init() {
    getActiveTab()
      .then(function (tab) {
        activeTab = tab;
        return refreshState(tab);
      })
      .catch(function () {
        setStatus('Open a local HTML document to start annotating.');
        disableActions(true);
      });

    btnToggle.addEventListener('click', function () {
      runAction('NOTEBACK_TOGGLE_SIDEBAR', 'Toggling sidebar…', function () {
        window.close();
      });
    });

    btnCopy.addEventListener('click', function () {
      runAction('NOTEBACK_COPY_MARKDOWN', 'Copying Markdown…', function (resp) {
        setStatus(resp && resp.ok ? 'Copied feedback as Markdown.' : 'Copy failed.');
      }, /*keepOpen*/ true);
    });

    btnSave.addEventListener('click', function () {
      runAction('NOTEBACK_SAVE_CANVAS', 'Saving HTML canvas…', function (resp) {
        setStatus(resp && resp.ok ? 'Saving HTML canvas…' : 'Save failed.');
        if (resp && resp.ok) setTimeout(function () { window.close(); }, 600);
      }, /*keepOpen*/ true);
    });
  }

  /**
   * Determine whether the content script is live in the tab and whether the
   * onboarding card is needed (file:// + access disabled).
   */
  function refreshState(tab) {
    const url = (tab && tab.url) || '';
    const isFile = /^file:\/\//i.test(url);
    const isLocalHttp = /^https?:\/\/(localhost|127\.0\.0\.1)([:/]|$)/i.test(url);
    const isSupported = isFile || isLocalHttp;

    if (!isSupported) {
      setStatus('Noteback works on local file:// and localhost documents.');
      disableActions(true);
      return Promise.resolve();
    }

    // Is the content script booted in this tab?
    return ping(tab.id).then(function (pong) {
      if (pong && pong.booted) {
        disableActions(false);
        const n = countLabel(pong);
        setStatus(n);
        hideOnboarding();
        return;
      }
      // Not booted. On a file:// page this usually means file-URL access is off.
      return handleNotBooted(isFile);
    }).catch(function () {
      return handleNotBooted(isFile);
    });
  }

  function handleNotBooted(isFile) {
    if (isFile) {
      // Confirm via the service worker whether file access is the cause.
      return checkFileAccess().then(function (allowed) {
        if (!allowed) {
          showOnboarding();
          disableActions(true);
          setStatus('Action needed to annotate local files.');
        } else {
          // Access is on but the script hasn't booted (e.g. page still loading).
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
    if (!activeTab || activeTab.id == null) {
      setStatus('No active document.');
      return;
    }
    setStatus(pending);
    sendToTab(activeTab.id, { type: type }).then(
      function (resp) {
        if (typeof onDone === 'function') onDone(resp);
        if (!keepOpen && (!resp || resp.ok !== false)) {
          // Default: leave the popup open unless the handler closed it.
        }
      },
      function (err) {
        setStatus('Could not reach the page. Reload and try again.');
        void err;
      }
    );
  }

  function disableActions(disabled) {
    [btnToggle, btnCopy, btnSave].forEach(function (b) {
      if (b) b.disabled = !!disabled;
    });
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

  function hideOnboarding() {
    onboardingEl.hidden = true;
    onboardingEl.innerHTML = '';
  }

  /* --- messaging --------------------------------------------------------- */

  function ping(tabId) {
    return sendToTab(tabId, { type: 'NOTEBACK_PING' });
  }

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
      } catch (e) {
        reject(e);
      }
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
      } catch (e) {
        reject(e);
      }
    });
  }

  /* --- misc -------------------------------------------------------------- */

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text || '';
  }

  function truncate(s, n) {
    s = String(s == null ? '' : s);
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }
});
