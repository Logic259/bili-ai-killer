/**
 * Bili-AI-Killer — Manifest V3 Background Service Worker (v3.0)
 * Handles persistent settings, cross-tab confirmed bot memory, per-tab blocked logs,
 * toolbar badge counters, UID/@uname whitelisting, live sample testing, and batched LLM calls.
 */
import '../core/rules.js';
import '../core/detector.js';
import { judgeCommentsBatch, testLlmConnection, PROVIDER_PRESETS } from './llm-judge.js';

const {
  DEFAULT_SETTINGS,
  BUILTIN_PRESET_KEYWORDS,
  CATEGORY_META,
  normalizeSettings,
  evaluateComment,
} = globalThis.__BAK_CORE__.detector;

const STORAGE_KEY_SETTINGS = 'bak_settings';
const STORAGE_KEY_STATS = 'bak_stats';
const STORAGE_KEY_LLM_CACHE = 'bak_llm_cache';
const SESSION_KEY_BOTS = 'bak_session_bots';
const MAX_TAB_LOGS = 60;
const MAX_LLM_CACHE = 1200;
const MAX_SESSION_BOTS = 1200;

const memTabState = new Map();
let memSessionBots = null;
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

async function getConfirmedBots() {
  if (Array.isArray(memSessionBots)) return memSessionBots;
  if (chrome.storage.session) {
    const res = await chrome.storage.session.get([SESSION_KEY_BOTS]);
    memSessionBots = Array.isArray(res && res[SESSION_KEY_BOTS]) ? res[SESSION_KEY_BOTS] : [];
  } else {
    memSessionBots = [];
  }
  return memSessionBots;
}

async function addConfirmedBot(uid) {
  const cleanUid = String(uid || '').trim();
  if (!/^\d+$/.test(cleanUid)) return;
  const list = await getConfirmedBots();
  if (list.includes(cleanUid)) return;
  list.push(cleanUid);
  while (list.length > MAX_SESSION_BOTS) {
    list.shift();
  }
  if (chrome.storage.session) {
    await chrome.storage.session.set({ [SESSION_KEY_BOTS]: list });
  }
}

async function removeConfirmedBot(uid) {
  const cleanUid = String(uid || '').trim();
  if (!cleanUid) return;
  const list = await getConfirmedBots();
  const next = list.filter((x) => x !== cleanUid);
  if (next.length !== list.length) {
    memSessionBots = next;
    if (chrome.storage.session) {
      await chrome.storage.session.set({ [SESSION_KEY_BOTS]: next });
    }
  }
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
        const [settings, confirmedBots] = await Promise.all([getSettings(), getConfirmedBots()]);
        sendResponse({ ok: true, settings, confirmedBots, presets: PROVIDER_PRESETS });
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

      case 'RECORD_CONFIRMED_BOT': {
        if (msg.uid) {
          await addConfirmedBot(msg.uid);
        }
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
          categoryMeta: CATEGORY_META,
        });
        break;
      }

      case 'EVALUATE_SAMPLE': {
        const settings = await getSettings();
        const sample = msg.sample && typeof msg.sample === 'object' ? msg.sample : {};
        const verdict = evaluateComment(sample, settings, {});
        sendResponse({ ok: true, verdict });
        break;
      }

      case 'ADD_WHITELIST_UID': {
        const rawUid = String(msg.uid || '').trim();
        const rawUname = String(msg.uname || '').trim();
        let token = '';
        if (/^\d+$/.test(rawUid)) {
          token = rawUid;
          await removeConfirmedBot(rawUid);
        } else if (rawUid.startsWith('@') && rawUid.length > 1) {
          token = rawUid;
        } else if (rawUname) {
          token = `@${rawUname}`;
        }

        if (!token) {
          sendResponse({ ok: false, error: '无效的 UID 或昵称' });
          break;
        }

        const settings = await getSettings();
        if (!settings.whitelistUids.includes(token)) {
          settings.whitelistUids.push(token);
        }
        settings.blacklistUids = settings.blacklistUids.filter((x) => x !== token);
        const saved = await saveSettings(settings);

        if (senderTabId > 0) {
          const tabState = await getTabState(senderTabId);
          const beforeLen = (tabState.logs || []).length;
          tabState.logs = (tabState.logs || []).filter((item) => {
            if (/^\d+$/.test(token)) return String(item.uid) !== token;
            return `@${item.uname || ''}` !== token;
          });
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
        memSessionBots = [];
        const clearPromises = [
          chrome.storage.local.set({
            [STORAGE_KEY_STATS]: { totalBlocked: 0, byCategory: {} },
            [STORAGE_KEY_LLM_CACHE]: [],
          }),
        ];
        if (chrome.storage.session) {
          clearPromises.push(chrome.storage.session.set({ [SESSION_KEY_BOTS]: [] }));
        }
        await Promise.all(clearPromises);
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

  return true;
});
