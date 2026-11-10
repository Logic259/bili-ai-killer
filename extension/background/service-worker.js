/**
 * Bili-AI-Killer — Manifest V3 Background Service Worker
 * Handles persistent settings, per-tab blocked logs (via chrome.storage.session),
 * toolbar badge counters, UID whitelist/blacklist updates, and batched LLM API calls.
 */
import '../core/rules.js';
import '../core/detector.js';
import { judgeCommentsBatch, testLlmConnection, PROVIDER_PRESETS } from './llm-judge.js';

const { DEFAULT_SETTINGS, BUILTIN_PRESET_KEYWORDS, normalizeSettings } = globalThis.__BAK_CORE__.detector;

const STORAGE_KEY_SETTINGS = 'bak_settings';
const STORAGE_KEY_STATS = 'bak_stats';
const STORAGE_KEY_LLM_CACHE = 'bak_llm_cache';
const MAX_TAB_LOGS = 50;
const MAX_LLM_CACHE = 1200;

const memTabState = new Map();
let llmCacheMap = null;

async function getSettings() {
  const res = await chrome.storage.local.get([STORAGE_KEY_SETTINGS]);
  if (res && res[STORAGE_KEY_SETTINGS]) {
    return normalizeSettings(res[STORAGE_KEY_SETTINGS]);
  }
  const defaults = normalizeSettings(DEFAULT_SETTINGS);
  await chrome.storage.local.set({ [STORAGE_KEY_SETTINGS]: defaults });
  return defaults;
}

async function saveSettings(partial) {
  const normalized = normalizeSettings(partial);
  await chrome.storage.local.set({ [STORAGE_KEY_SETTINGS]: normalized });
  return normalized;
}

async function getStats() {
  const res = await chrome.storage.local.get([STORAGE_KEY_STATS]);
  const raw = (res && res[STORAGE_KEY_STATS]) || {};
  return {
    totalBlocked: Number(raw.totalBlocked) || 0,
    byCategory: raw.byCategory && typeof raw.byCategory === 'object' ? raw.byCategory : {},
  };
}

async function getTabState(tabId) {
  if (!tabId || tabId < 0) return { count: 0, url: '', logs: [] };
  const key = `tab_${tabId}`;
  if (chrome.storage.session) {
    const res = await chrome.storage.session.get([key]);
    if (res && res[key]) return res[key];
  } else if (memTabState.has(key)) {
    return memTabState.get(key);
  }
  return { count: 0, url: '', logs: [] };
}

async function setTabState(tabId, state) {
  if (!tabId || tabId < 0) return;
  const key = `tab_${tabId}`;
  if (chrome.storage.session) {
    await chrome.storage.session.set({ [key]: state });
  } else {
    memTabState.set(key, state);
  }
}

async function removeTabState(tabId) {
  if (!tabId || tabId < 0) return;
  const key = `tab_${tabId}`;
  if (chrome.storage.session) {
    await chrome.storage.session.remove([key]);
  } else {
    memTabState.delete(key);
  }
}

async function updateBadge(tabId, count, enabled = true) {
  if (!tabId || tabId < 0) return;
  try {
    if (!enabled) {
      await chrome.action.setBadgeText({ tabId, text: 'OFF' });
      await chrome.action.setBadgeBackgroundColor({ tabId, color: '#61666d' });
      return;
    }
    const text = count > 0 ? (count > 999 ? '999+' : String(count)) : '';
    await chrome.action.setBadgeText({ tabId, text });
    if (count > 0) {
      await chrome.action.setBadgeBackgroundColor({ tabId, color: '#fb7299' });
      if (chrome.action.setBadgeTextColor) {
        await chrome.action.setBadgeTextColor({ tabId, color: '#ffffff' });
      }
    }
  } catch (_err) {
    // Tab may have closed
  }
}

async function ensureLlmCache() {
  if (llmCacheMap) return llmCacheMap;
  llmCacheMap = new Map();
  try {
    const res = await chrome.storage.local.get([STORAGE_KEY_LLM_CACHE]);
    const arr = res && Array.isArray(res[STORAGE_KEY_LLM_CACHE]) ? res[STORAGE_KEY_LLM_CACHE] : [];
    for (const pair of arr) {
      if (Array.isArray(pair) && pair.length === 2 && pair[0]) {
        llmCacheMap.set(String(pair[0]), pair[1]);
      }
    }
  } catch (_e) {
    // ignore
  }
  return llmCacheMap;
}

async function persistLlmCache() {
  if (!llmCacheMap) return;
  while (llmCacheMap.size > MAX_LLM_CACHE) {
    const oldest = llmCacheMap.keys().next().value;
    llmCacheMap.delete(oldest);
  }
  const serialized = Array.from(llmCacheMap.entries());
  await chrome.storage.local.set({ [STORAGE_KEY_LLM_CACHE]: serialized });
}

// Serialize per-tab state mutations to avoid race conditions during burst scrolling
let recordChain = Promise.resolve();

function enqueueRecordTask(fn) {
  recordChain = recordChain.then(fn, fn);
  return recordChain;
}

chrome.runtime.onInstalled.addListener(async () => {
  await getSettings();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  removeTabState(tabId).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return false;

  const senderTabId = (sender && sender.tab && sender.tab.id) || msg.tabId || -1;

  (async () => {
    switch (msg.type) {
      case 'GET_SETTINGS': {
        const settings = await getSettings();
        sendResponse({ ok: true, settings, presets: PROVIDER_PRESETS });
        break;
      }

      case 'SAVE_SETTINGS': {
        const settings = await saveSettings(msg.settings || {});
        if (msg.activeTabId) {
          const st = await getTabState(msg.activeTabId);
          await updateBadge(msg.activeTabId, st.count, settings.enabled);
        }
        sendResponse({ ok: true, settings });
        break;
      }

      case 'TAB_RESET': {
        const settings = await getSettings();
        await setTabState(senderTabId, { count: 0, url: msg.url || '', logs: [] });
        await updateBadge(senderTabId, 0, settings.enabled);
        sendResponse({ ok: true });
        break;
      }

      case 'RECORD_BLOCKED':
      case 'RECORD_BLOCKED_BATCH': {
        await enqueueRecordTask(async () => {
          const entries =
            msg.type === 'RECORD_BLOCKED_BATCH' && Array.isArray(msg.entries)
              ? msg.entries
              : msg.entry
                ? [msg.entry]
                : [];
          if (entries.length === 0) return;

          const [settings, tabState, stats] = await Promise.all([
            getSettings(),
            getTabState(senderTabId),
            getStats(),
          ]);

          tabState.count = (Number(tabState.count) || 0) + entries.length;
          tabState.logs = [...entries.slice().reverse(), ...(tabState.logs || [])].slice(0, MAX_TAB_LOGS);

          stats.totalBlocked = (Number(stats.totalBlocked) || 0) + entries.length;
          for (const entry of entries) {
            const cat = (entry && entry.category) || 'deepseek_style';
            stats.byCategory[cat] = (Number(stats.byCategory[cat]) || 0) + 1;
          }

          await Promise.all([
            setTabState(senderTabId, tabState),
            chrome.storage.local.set({ [STORAGE_KEY_STATS]: stats }),
            updateBadge(senderTabId, tabState.count, settings.enabled),
          ]);
        });
        sendResponse({ ok: true });
        break;
      }

      case 'GET_POPUP_DATA': {
        const targetTabId = Number(msg.tabId) || -1;
        const [settings, stats, tabState] = await Promise.all([
          getSettings(),
          getStats(),
          getTabState(targetTabId),
        ]);
        sendResponse({
          ok: true,
          settings,
          stats,
          tabState,
          presets: PROVIDER_PRESETS,
          builtinPresets: BUILTIN_PRESET_KEYWORDS,
        });
        break;
      }

      case 'ADD_WHITELIST_UID': {
        const uid = String(msg.uid || '').trim();
        if (!/^\d+$/.test(uid)) {
          sendResponse({ ok: false, error: '无效的 UID' });
          break;
        }
        const settings = await getSettings();
        if (!settings.whitelistUids.includes(uid)) {
          settings.whitelistUids.push(uid);
        }
        settings.blacklistUids = settings.blacklistUids.filter((x) => x !== uid);
        const saved = await saveSettings(settings);

        // Clean matching entries from active tab logs and update badge
        if (senderTabId > 0) {
          const tabState = await getTabState(senderTabId);
          const beforeLen = (tabState.logs || []).length;
          tabState.logs = (tabState.logs || []).filter((item) => String(item.uid) !== uid);
          const removed = Math.max(0, beforeLen - tabState.logs.length);
          tabState.count = Math.max(0, (tabState.count || 0) - removed);
          await setTabState(senderTabId, tabState);
          await updateBadge(senderTabId, tabState.count, saved.enabled);
        }

        sendResponse({ ok: true, settings: saved });
        break;
      }

      case 'LLM_JUDGE_BATCH': {
        const items = Array.isArray(msg.items) ? msg.items : [];
        const settings = await getSettings();
        if (!settings.enabled || !settings.llm.enabled) {
          sendResponse({ ok: true, verdicts: [] });
          break;
        }

        const cache = await ensureLlmCache();
        const cachedVerdicts = [];
        const uncachedItems = [];

        for (const item of items) {
          if (!item || !item.rpid) continue;
          const key = String(item.rpid);
          if (cache.has(key)) {
            cachedVerdicts.push(cache.get(key));
          } else {
            uncachedItems.push(item);
          }
        }

        let freshVerdicts = [];
        if (uncachedItems.length > 0) {
          try {
            freshVerdicts = await judgeCommentsBatch(uncachedItems, settings.llm);
            for (const v of freshVerdicts) {
              cache.set(String(v.rpid), v);
            }
            if (freshVerdicts.length > 0) {
              await persistLlmCache();
            }
          } catch (err) {
            console.warn('[Bili-AI-Killer] LLM batch error:', err);
          }
        }

        sendResponse({ ok: true, verdicts: [...cachedVerdicts, ...freshVerdicts] });
        break;
      }

      case 'TEST_LLM_CONNECTION': {
        const result = await testLlmConnection(msg.llmConfig || {});
        sendResponse(result);
        break;
      }

      case 'CLEAR_STATS': {
        await chrome.storage.local.set({
          [STORAGE_KEY_STATS]: { totalBlocked: 0, byCategory: {} },
          [STORAGE_KEY_LLM_CACHE]: [],
        });
        if (llmCacheMap) llmCacheMap.clear();
        sendResponse({ ok: true });
        break;
      }

      default:
        sendResponse({ ok: false, error: 'Unknown message type' });
    }
  })().catch((err) => {
    sendResponse({ ok: false, error: (err && err.message) || String(err) });
  });

  return true; // Keep message channel open for async response
});
