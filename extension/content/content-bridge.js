/**
 * Bili-AI-Killer — ISOLATED World Bridge (v3.0)
 * Connects MAIN world (injected-main.js) with chrome.storage & MV3 Service Worker.
 * Keeps API keys strictly isolated from page scripts and batches IPC writes.
 */
(function initContentBridge() {
  'use strict';

  const EVT_TO_MAIN = 'bak:bridge-to-main';
  const EVT_TO_ISOLATED = 'bak:main-to-bridge';
  const STORAGE_KEY_SETTINGS = 'bak_settings';
  const SESSION_KEY_BOTS = 'bak_session_bots';

  let cachedSettings = null;
  let cachedConfirmedBots = [];
  let llmQueue = [];
  let llmTimer = null;
  let blockedQueue = [];
  let blockedTimer = null;

  function isContextValid() {
    try {
      return Boolean(chrome && chrome.runtime && chrome.runtime.id);
    } catch (_e) {
      return false;
    }
  }

  function stripSensitiveForMain(settings) {
    if (!settings || typeof settings !== 'object') return {};
    const copy = JSON.parse(JSON.stringify(settings));
    if (copy.llm && typeof copy.llm === 'object') {
      const hasKey = Boolean(copy.llm.apiKey && String(copy.llm.apiKey).trim());
      copy.llm.apiKey = hasKey ? '__CONFIGURED__' : '';
    }
    return copy;
  }

  function sendToMain(type, payload, extra = {}) {
    try {
      const detail = JSON.stringify({ type, payload, ...extra });
      document.documentElement.dispatchEvent(new CustomEvent(EVT_TO_MAIN, { detail }));
    } catch (_err) {
      // ignore
    }
  }

  function safeSendRuntimeMessage(message, callback) {
    if (!isContextValid()) return;
    try {
      chrome.runtime.sendMessage(message, (resp) => {
        if (chrome.runtime.lastError) {
          return;
        }
        if (typeof callback === 'function') callback(resp);
      });
    } catch (_err) {
      // ignore extension reload race
    }
  }

  function syncSettingsFromStorage() {
    if (!isContextValid()) return;
    safeSendRuntimeMessage({ type: 'GET_SETTINGS' }, (resp) => {
      if (resp && resp.settings) {
        cachedSettings = resp.settings;
        cachedConfirmedBots = Array.isArray(resp.confirmedBots) ? resp.confirmedBots : [];
        sendToMain('SYNC_SETTINGS', stripSensitiveForMain(cachedSettings), {
          confirmedBots: cachedConfirmedBots,
        });
      }
    });
  }

  function flushLlmBatch() {
    llmTimer = null;
    if (llmQueue.length === 0) return;
    const batch = llmQueue.splice(0, 8);
    safeSendRuntimeMessage({ type: 'LLM_JUDGE_BATCH', items: batch }, (resp) => {
      if (resp && Array.isArray(resp.verdicts) && resp.verdicts.length > 0) {
        sendToMain('LLM_VERDICTS', resp.verdicts);
      }
    });
    if (llmQueue.length > 0) {
      llmTimer = setTimeout(flushLlmBatch, 350);
    }
  }

  function enqueueLlmItem(item) {
    if (!item || !item.rpid) return;
    if (llmQueue.some((x) => x.rpid === item.rpid)) return;
    llmQueue.push(item);
    if (llmQueue.length >= 8) {
      if (llmTimer) clearTimeout(llmTimer);
      flushLlmBatch();
    } else if (!llmTimer) {
      llmTimer = setTimeout(flushLlmBatch, 380);
    }
  }

  function flushBlockedBatch() {
    blockedTimer = null;
    if (blockedQueue.length === 0) return;
    const entries = blockedQueue.splice(0, blockedQueue.length);
    safeSendRuntimeMessage({ type: 'RECORD_BLOCKED_BATCH', entries });
  }

  function enqueueBlockedEntry(entry) {
    if (!entry) return;
    blockedQueue.push(entry);
    if (!blockedTimer) {
      blockedTimer = setTimeout(flushBlockedBatch, 120);
    }
  }

  document.documentElement.addEventListener(EVT_TO_ISOLATED, (ev) => {
    if (!ev || typeof ev.detail !== 'string') return;
    try {
      const msg = JSON.parse(ev.detail);
      if (!msg || !msg.type) return;

      switch (msg.type) {
        case 'MAIN_READY':
          safeSendRuntimeMessage({ type: 'TAB_RESET', url: (msg.payload && msg.payload.url) || location.href });
          if (cachedSettings) {
            sendToMain('SYNC_SETTINGS', stripSensitiveForMain(cachedSettings), {
              confirmedBots: cachedConfirmedBots,
            });
          } else {
            syncSettingsFromStorage();
          }
          break;

        case 'PAGE_RESET':
          llmQueue = [];
          blockedQueue = [];
          if (blockedTimer) {
            clearTimeout(blockedTimer);
            blockedTimer = null;
          }
          safeSendRuntimeMessage({ type: 'TAB_RESET', url: (msg.payload && msg.payload.url) || location.href });
          break;

        case 'COMMENT_BLOCKED':
          enqueueBlockedEntry(msg.payload);
          break;

        case 'RECORD_CONFIRMED_BOT':
          safeSendRuntimeMessage({
            type: 'RECORD_CONFIRMED_BOT',
            uid: msg.payload && msg.payload.uid,
            uname: msg.payload && msg.payload.uname,
          });
          break;

        case 'ADD_WHITELIST_UID':
          safeSendRuntimeMessage({
            type: 'ADD_WHITELIST_UID',
            uid: msg.payload && msg.payload.uid,
            uname: msg.payload && msg.payload.uname,
          });
          break;

        case 'QUEUE_LLM_CHECK':
          enqueueLlmItem(msg.payload);
          break;

        default:
          break;
      }
    } catch (_err) {
      // ignore
    }
  });

  if (isContextValid() && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'local' && changes[STORAGE_KEY_SETTINGS]) {
        cachedSettings = changes[STORAGE_KEY_SETTINGS].newValue;
        if (cachedSettings) {
          sendToMain('SYNC_SETTINGS', stripSensitiveForMain(cachedSettings), {
            confirmedBots: cachedConfirmedBots,
          });
        }
      } else if (areaName === 'session' && changes[SESSION_KEY_BOTS]) {
        const nextBots = changes[SESSION_KEY_BOTS].newValue;
        if (Array.isArray(nextBots)) {
          cachedConfirmedBots = nextBots;
          sendToMain('SYNC_CONFIRMED_BOTS', cachedConfirmedBots);
        }
      }
    });
  }

  syncSettingsFromStorage();
})();
