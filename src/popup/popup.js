/**
 * Noteback — popup.js  (toolbar popup logic)
 *
 * Wires the popup buttons to the active tab's content script / the service
 * worker, renders the file-URL onboarding card, and drives the Save dropdown.
 */
'use strict';

document.addEventListener('DOMContentLoaded', function () {
  const byId = function (id) { return document.getElementById(id); };
  const policy = (window.NotebackRuntime || {}).originPolicy || null;
  const SETTINGS_KEY = (policy && policy.SETTINGS_KEY) || 'nb:settings';

  const btnToggle = byId('nb-toggle-sidebar');
  const btnCopy = byId('nb-copy-markdown');
  const saveBtn = byId('nb-save-btn');
  const saveMenu = byId('nb-save-menu');
  const onboardingEl = byId('nb-onboarding');
  const statusEl = byId('nb-status');
  const gearBtn = byId('nb-gear');
  const infoBtn = byId('nb-info-btn');
  const settingsPanel = byId('nb-settings');
  const infoSection = byId('nb-info');
  const siteRow = byId('nb-site-row');
  const siteOriginEl = byId('nb-site-origin');
  const siteToggle = byId('nb-site-toggle');
  const siteHint = byId('nb-site-hint');
  const typeInputs = {
    file: byId('nb-type-file'),
    localhost: byId('nb-type-localhost'),
    '127.0.0.1': byId('nb-type-127')
  };

  let activeTab = null;
  let tabInfo = { type: 'other', origin: '' };
  let settings = null;

  init();

  function init() {
    getSettings().then(function (s) { settings = s; renderTypeSwitches(); });

    getActiveTab()
      .then(function (tab) { activeTab = tab; tabInfo = deriveTabInfo(tab); return refreshState(tab); })
      .catch(function () {
        setStatus('Open a local HTML document to start annotating.');
        disableActions(true);
      });

    gearBtn.addEventListener('click', function () {
      const opening = settingsPanel.hasAttribute('hidden');
      if (opening) {
        settingsPanel.removeAttribute('hidden'); gearBtn.setAttribute('aria-expanded', 'true');
        hideInfo();
      } else { settingsPanel.setAttribute('hidden', ''); gearBtn.setAttribute('aria-expanded', 'false'); }
    });

    infoBtn.addEventListener('click', function () {
      const opening = infoSection.hasAttribute('hidden');
      if (opening) {
        infoSection.removeAttribute('hidden'); infoBtn.setAttribute('aria-expanded', 'true');
        settingsPanel.setAttribute('hidden', ''); gearBtn.setAttribute('aria-expanded', 'false');
      } else { hideInfo(); }
    });
    infoSection.addEventListener('click', function (e) {
      const item = e.target.closest('.nb-cmd-copy');
      if (item) copyCmd(item.getAttribute('data-cmd') || '');
    });

    Object.keys(typeInputs).forEach(function (type) {
      const input = typeInputs[type];
      if (!input) return;
      input.addEventListener('change', function () {
        settings = withType(settings, type, input.checked);
        saveSettings(settings).then(function () { renderTypeSwitches(); refreshState(activeTab); });
      });
    });

    siteToggle.addEventListener('change', function () {
      if (!tabInfo || tabInfo.type === 'other') return;
      settings = withSite(settings, tabInfo.origin, siteToggle.checked);
      saveSettings(settings).then(function () { refreshState(activeTab); });
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
    if (!tab) return Promise.resolve();
    return ping(tab.id).then(function (pong) {
      // Content script is injected (PING answered).
      hideOnboarding();
      if (pong && pong.booted) {
        disableActions(false);
        showSiteRow(true);              // no-ops for 'other' origins
        setStatus(countLabel(pong));
      } else {
        // Injected but dormant by settings (file/localhost/127 only).
        disableActions(true);
        showSiteRow(false);
        setStatus('Noteback is off on this site.');
      }
    }).catch(function () {
      // Not injected. Unsupported ('other') origins can be click-activated;
      // supported origins that didn't boot keep the existing path (file access
      // off, or page still loading).
      hideSiteRow();
      if (tabInfo && tabInfo.type === 'other') return showAnnotatePrompt();
      return handleNotBooted(tabInfo && tabInfo.type === 'file');
    });
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

  /* --- annotate-this-page (unsupported origins) -------------------------- */

  /**
   * On an origin Noteback doesn't auto-inject (anything that isn't file://,
   * localhost, or 127.0.0.1), offer one-click activation. activeTab grants us
   * access to this tab the moment the user opened the popup, so we inject the
   * runtime on demand — no host permission, no prompt.
   */
  function showAnnotatePrompt() {
    disableActions(true);
    setStatus('');
    onboardingEl.hidden = false;
    onboardingEl.innerHTML =
      '<div class="nb-annotate">' +
      '  <p class="nb-annotate__lead">Annotate any document you open — highlight text and leave comments, then copy the feedback as Markdown.</p>' +
      '  <button id="nb-annotate-btn" type="button" class="nb-btn nb-btn--primary">Annotate this page</button>' +
      '  <p class="nb-annotate__note">Stays on until you reload. Comments are saved for this page.</p>' +
      '</div>';
    const btn = document.getElementById('nb-annotate-btn');
    if (btn) btn.addEventListener('click', annotateThisPage);
    return Promise.resolve();
  }

  /**
   * Inject the extension runtime into the active tab on the user's click. We set
   * window.__notebackForceActivate (read by content-script.js to mount
   * unconditionally), then inject the SAME ordered file list the manifest would
   * auto-inject — sourced from getManifest() so it can never drift.
   */
  function annotateThisPage() {
    if (!activeTab || activeTab.id == null) { setStatus('No active document.'); return; }
    const cs = (chrome.runtime.getManifest().content_scripts || [])[0] || {};
    const files = cs.js || [];
    if (!files.length) { setStatus('Could not load Noteback.'); return; }
    setStatus('Activating Noteback…');
    chrome.scripting.executeScript({ target: { tabId: activeTab.id }, func: setForceActivate })
      .then(function () {
        return chrome.scripting.executeScript({ target: { tabId: activeTab.id }, files: files });
      })
      .then(function () { hideOnboarding(); refreshState(activeTab); })
      .catch(function () { setStatus("Can't annotate this page."); });
  }

  /** Injected into the page's isolated world before the runtime files. */
  function setForceActivate() { window.__notebackForceActivate = true; }

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

  /* --- settings + per-origin --------------------------------------------- */

  function deriveTabInfo(tab) {
    const url = (tab && tab.url) || '';
    try {
      const u = new URL(url);
      const loc = { protocol: u.protocol, hostname: u.hostname, host: u.host, origin: u.origin };
      return {
        type: policy ? policy.classifyOrigin(loc) : 'other',
        origin: policy ? policy.originOf(loc) : u.origin
      };
    } catch (e) { return { type: 'other', origin: '' }; }
  }

  function typeOn(type) {
    const norm = policy ? policy.normalizeSettings(settings) : { origins: { file: true, localhost: true, '127.0.0.1': true } };
    return norm.origins[type] !== false;
  }

  function renderTypeSwitches() {
    const norm = policy ? policy.normalizeSettings(settings) : { origins: { file: true, localhost: true, '127.0.0.1': true } };
    if (typeInputs.file) typeInputs.file.checked = norm.origins.file;
    if (typeInputs.localhost) typeInputs.localhost.checked = norm.origins.localhost;
    if (typeInputs['127.0.0.1']) typeInputs['127.0.0.1'].checked = norm.origins['127.0.0.1'];
  }

  function showSiteRow(active) {
    if (!tabInfo || tabInfo.type === 'other') { hideSiteRow(); return; }
    siteRow.removeAttribute('hidden');
    siteOriginEl.textContent = tabInfo.origin;
    if (!typeOn(tabInfo.type)) {
      // Per-site can't override a type that's switched off.
      siteToggle.checked = false;
      siteToggle.disabled = true;
      siteHint.textContent = tabInfo.type + ' is off in settings';
      siteHint.hidden = false;
    } else {
      siteToggle.disabled = false;
      siteToggle.checked = !!active;
      siteHint.hidden = true;
      siteHint.textContent = '';
    }
  }

  function hideSiteRow() { siteRow.setAttribute('hidden', ''); }

  function withType(s, type, on) {
    const norm = policy ? policy.normalizeSettings(s) : { origins: { file: true, localhost: true, '127.0.0.1': true }, disabledSites: [] };
    norm.origins[type] = !!on;
    return norm;
  }

  function withSite(s, origin, on) {
    const norm = policy ? policy.normalizeSettings(s) : { origins: { file: true, localhost: true, '127.0.0.1': true }, disabledSites: [] };
    const list = norm.disabledSites.slice();
    const idx = list.indexOf(origin);
    if (on) { if (idx !== -1) list.splice(idx, 1); }   // enable site → remove from disabled
    else { if (idx === -1) list.push(origin); }        // disable site → add to disabled
    norm.disabledSites = list;
    return norm;
  }

  function getSettings() {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get(SETTINGS_KEY, function (items) {
          const err = chrome.runtime && chrome.runtime.lastError;
          resolve((!err && items && items[SETTINGS_KEY]) || null);
        });
      } catch (e) { resolve(null); }
    });
  }

  function saveSettings(s) {
    return new Promise(function (resolve, reject) {
      const bag = {}; bag[SETTINGS_KEY] = s;
      try {
        chrome.storage.local.set(bag, function () {
          const err = chrome.runtime && chrome.runtime.lastError;
          if (err) { reject(new Error(err.message || String(err))); return; }
          resolve();
        });
      } catch (e) { reject(e); }
    });
  }

  /* --- info dialog ------------------------------------------------------- */

  function hideInfo() { infoSection.setAttribute('hidden', ''); infoBtn.setAttribute('aria-expanded', 'false'); }

  function copyCmd(cmd) {
    if (!cmd) return;
    const done = function (ok) { setStatus(ok ? 'Copied command.' : 'Copy failed — select & copy manually.'); };
    try {
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(cmd).then(function () { done(true); }, function () { done(false); });
        return;
      }
    } catch (e) { /* fall through */ }
    done(false);
  }

  /* --- misc -------------------------------------------------------------- */

  function setStatus(text) { if (statusEl) statusEl.textContent = text || ''; }
  function truncate(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
});
