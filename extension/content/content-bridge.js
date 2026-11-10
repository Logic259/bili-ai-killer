/**
 * Bili-AI-Killer — ISOLATED World Bridge
 * Connects MAIN world (injected-main.js) with chrome.storage.local & MV3 Service Worker.
 * Keeps API keys and extension storage strictly isolated from page scripts.
 */
(function initContentBridge() {
  'use strict';

  const EVT_TO_MAIN = 'bak:bridge-to-main';
  const EVT_TO_ISOLATED = 'bak:main-to-bridge';
  const STORAGE_KEY_SETTINGS = 'bak_settings';

  let cachedSettings = null;
  let llmQueue = [];
  let llmTimer = null;

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
    // Never expose raw API key string to MAIN world; only pass boolean readiness flag
    if (copy.llm && typeof copy.llm === 'object') {
      const hasKey = Boolean(copy.llm.apiKey && String(copy.llm.apiKey).trim());
      copy.llm.apiKey = hasKey ? '__CONFIGURED__' : '';
    }
    return copy;
  }

  function sendToMain(type, payload) {
    try {
      const detail = JSON.stringify({ type, payload });
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
    try {
      chrome.storage.local.get([STORAGE_KEY_SETTINGS], (res) => {
        if (chrome.runtime.lastError) return;
        cachedSettings = (res && res[STORAGE_KEY_SETTINGS]) || null;
        if (cachedSettings) {
          sendToMain('SYNC_SETTINGS', stripSensitiveForMain(cachedSettings));
        } else {
          safeSendRuntimeMessage({ type: 'GET_SETTINGS' }, (resp) => {
            if (resp && resp.settings) {
              cachedSettings = resp.settings;
              sendToMain('SYNC_SETTINGS', stripSensitiveForMain(cachedSettings));
            }
          });
        }
      });
    } catch (_err) {
      // ignore
    }
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

  // Listen to events emitted by MAIN world
  document.documentElement.addEventListener(EVT_TO_ISOLATED, (ev) => {
    if (!ev || typeof ev.detail !== 'string') return;
    try {
      const msg = JSON.parse(ev.detail);
      if (!msg || !msg.type) return;

      switch (msg.type) {
        case 'MAIN_READY':
          safeSendRuntimeMessage({ type: 'TAB_RESET', url: (msg.payload && msg.payload.url) || location.href });
          if (cachedSettings) {
            sendToMain('SYNC_SETTINGS', stripSensitiveForMain(cachedSettings));
          } else {
            syncSettingsFromStorage();
          }
          break;

        case 'PAGE_RESET':
          llmQueue = [];
          safeSendRuntimeMessage({ type: 'TAB_RESET', url: (msg.payload && msg.payload.url) || location.href });
          break;

        case 'COMMENT_BLOCKED':
          safeSendRuntimeMessage({ type: 'RECORD_BLOCKED', entry: msg.payload });
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

  // Automatically propagate settings updates from Popup / Storage to MAIN world without reload
  if (isContextValid() && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'local' && changes[STORAGE_KEY_SETTINGS]) {
        cachedSettings = changes[STORAGE_KEY_SETTINGS].newValue;
        if (cachedSettings) {
          sendToMain('SYNC_SETTINGS', stripSensitiveForMain(cachedSettings));
        }
      }
    });
  }

  syncSettingsFromStorage();
})();
