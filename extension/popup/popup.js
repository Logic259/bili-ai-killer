/**
 * Bili-AI-Killer — Popup Control Center Logic
 */

const SENSITIVITY_HINTS = {
  relaxed: '阈值 75 · 仅拦截高确信度AI号',
  standard: '阈值 55 · 平衡识别与防误伤',
  strict: '阈值 40 · 强力猎杀伪装DeepSeek腔',
};

let activeTabId = -1;
let currentSettings = null;
let providerPresets = {};
let builtinPresetKeywords = [];

const els = {
  enabledToggle: document.getElementById('enabled-toggle'),
  statusSubtitle: document.getElementById('status-subtitle'),
  statTabCount: document.getElementById('stat-tab-count'),
  statTotalCount: document.getElementById('stat-total-count'),
  logsPill: document.getElementById('logs-pill'),
  tabBtns: Array.from(document.querySelectorAll('.tab-btn')),
  panels: {
    rules: document.getElementById('panel-rules'),
    logs: document.getElementById('panel-logs'),
    advanced: document.getElementById('panel-advanced'),
  },
  displayModeBtns: Array.from(document.querySelectorAll('#display-mode-seg .seg-btn')),
  sensitivityBtns: Array.from(document.querySelectorAll('#sensitivity-seg .seg-btn')),
  sensitivityHint: document.getElementById('sensitivity-hint'),
  catCheckboxes: Array.from(document.querySelectorAll('.cat-checkbox')),
  protectUpperCheck: document.getElementById('protect-upper-check'),
  logsContainer: document.getElementById('logs-container'),
  llmEnabledToggle: document.getElementById('llm-enabled-toggle'),
  llmProvider: document.getElementById('llm-provider'),
  llmBaseUrl: document.getElementById('llm-base-url'),
  llmApiKey: document.getElementById('llm-api-key'),
  llmModel: document.getElementById('llm-model'),
  llmAggressiveCheck: document.getElementById('llm-aggressive-check'),
  saveLlmBtn: document.getElementById('save-llm-btn'),
  llmTestStatus: document.getElementById('llm-test-status'),
  customKeywordsInput: document.getElementById('custom-keywords-input'),
  restorePresetsBtn: document.getElementById('restore-presets-btn'),
  whitelistUidsInput: document.getElementById('whitelist-uids-input'),
  blacklistUidsInput: document.getElementById('blacklist-uids-input'),
  saveListsBtn: document.getElementById('save-lists-btn'),
  clearStatsBtn: document.getElementById('clear-stats-btn'),
  listsSaveStatus: document.getElementById('lists-save-status'),
};

function sendMsg(payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(payload, (resp) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(resp || { ok: false });
    });
  });
}

function setStatusMessage(el, text, isOk = true) {
  if (!el) return;
  el.textContent = text;
  el.className = `status-msg ${isOk ? 'ok' : 'err'}`;
}

function parseMultilineList(text) {
  return String(text || '')
    .split(/[\r\n,，;；]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function renderSettingsToUI(settings) {
  if (!settings) return;
  els.enabledToggle.checked = Boolean(settings.enabled);
  els.statusSubtitle.textContent = settings.enabled
    ? '实时守护评论区净土（修改即时生效）'
    : '已暂停评论区净化';

  for (const btn of els.displayModeBtns) {
    btn.classList.toggle('active', btn.dataset.value === settings.displayMode);
  }
  for (const btn of els.sensitivityBtns) {
    btn.classList.toggle('active', btn.dataset.value === settings.sensitivity);
  }
  els.sensitivityHint.textContent =
    SENSITIVITY_HINTS[settings.sensitivity] || SENSITIVITY_HINTS.standard;

  for (const cb of els.catCheckboxes) {
    const key = cb.dataset.cat;
    cb.checked = Boolean(settings.categories && settings.categories[key]);
  }

  els.protectUpperCheck.checked = Boolean(settings.protectUpper);

  const llm = settings.llm || {};
  els.llmEnabledToggle.checked = Boolean(llm.enabled);
  els.llmProvider.value = llm.provider || 'deepseek';
  els.llmBaseUrl.value = llm.baseUrl || '';
  els.llmApiKey.value = llm.apiKey || '';
  els.llmModel.value = llm.model || '';
  els.llmAggressiveCheck.checked = Boolean(llm.aggressiveScan);

  els.customKeywordsInput.value = (settings.customKeywords || []).join('\n');
  els.whitelistUidsInput.value = (settings.whitelistUids || []).join('\n');
  els.blacklistUidsInput.value = (settings.blacklistUids || []).join('\n');
}

function renderStatsAndLogs(stats, tabState) {
  const tabCount = Number(tabState && tabState.count) || 0;
  const totalCount = Number(stats && stats.totalBlocked) || 0;
  els.statTabCount.textContent = String(tabCount);
  els.statTotalCount.textContent = String(totalCount);
  els.logsPill.textContent = String(tabCount);

  const logs = (tabState && Array.isArray(tabState.logs) && tabState.logs) || [];
  els.logsContainer.replaceChildren();

  if (logs.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = '当前页面暂未发现或拦截 AI 评论';
    els.logsContainer.appendChild(empty);
    return;
  }

  for (const item of logs) {
    const card = document.createElement('div');
    card.className = 'log-card';

    const top = document.createElement('div');
    top.className = 'log-top';

    const author = document.createElement('span');
    author.className = 'log-author';
    author.textContent = `@${item.uname || '未知用户'}${item.uid ? ` (UID: ${item.uid})` : ''}`;

    const tag = document.createElement('span');
    tag.className = 'log-tag';
    tag.textContent = item.categoryLabel || 'AI疑似';

    top.append(author, tag);

    const snippet = document.createElement('div');
    snippet.className = 'log-snippet';
    snippet.textContent = item.snippet || (item.sign ? `[签名] ${item.sign}` : '(无正文摘要)');

    const foot = document.createElement('div');
    foot.className = 'log-foot';

    const reasons = document.createElement('span');
    reasons.className = 'log-reasons';
    reasons.textContent = (item.reasons || []).join(' · ') || `得分 ${item.score || 0}`;
    foot.appendChild(reasons);

    if (item.uid) {
      const whiteBtn = document.createElement('button');
      whiteBtn.type = 'button';
      whiteBtn.className = 'whitelist-mini-btn';
      whiteBtn.textContent = '误伤加白';
      whiteBtn.addEventListener('click', async () => {
        whiteBtn.disabled = true;
        await sendMsg({
          type: 'ADD_WHITELIST_UID',
          tabId: activeTabId,
          uid: item.uid,
          uname: item.uname,
        });
        await refreshPopupData();
      });
      foot.appendChild(whiteBtn);
    }

    card.append(top, snippet, foot);
    els.logsContainer.appendChild(card);
  }
}

async function persistCurrentSettings() {
  if (!currentSettings) return;
  const resp = await sendMsg({
    type: 'SAVE_SETTINGS',
    activeTabId,
    settings: currentSettings,
  });
  if (resp && resp.settings) {
    currentSettings = resp.settings;
    renderSettingsToUI(currentSettings);
  }
}

async function refreshPopupData() {
  const resp = await sendMsg({ type: 'GET_POPUP_DATA', tabId: activeTabId });
  if (!resp || !resp.ok) return;
  currentSettings = resp.settings;
  providerPresets = resp.presets || {};
  builtinPresetKeywords = Array.isArray(resp.builtinPresets) ? resp.builtinPresets : [];
  renderSettingsToUI(currentSettings);
  renderStatsAndLogs(resp.stats, resp.tabState);
}

// Tab switching
for (const btn of els.tabBtns) {
  btn.addEventListener('click', () => {
    const target = btn.dataset.tab;
    for (const b of els.tabBtns) b.classList.toggle('active', b === btn);
    for (const [key, panel] of Object.entries(els.panels)) {
      panel.classList.toggle('active', key === target);
    }
  });
}

// Strategy controls
els.enabledToggle.addEventListener('change', () => {
  if (!currentSettings) return;
  currentSettings.enabled = els.enabledToggle.checked;
  persistCurrentSettings();
});

for (const btn of els.displayModeBtns) {
  btn.addEventListener('click', () => {
    if (!currentSettings) return;
    currentSettings.displayMode = btn.dataset.value;
    persistCurrentSettings();
  });
}

for (const btn of els.sensitivityBtns) {
  btn.addEventListener('click', () => {
    if (!currentSettings) return;
    currentSettings.sensitivity = btn.dataset.value;
    persistCurrentSettings();
  });
}

for (const cb of els.catCheckboxes) {
  cb.addEventListener('change', () => {
    if (!currentSettings) return;
    currentSettings.categories[cb.dataset.cat] = cb.checked;
    persistCurrentSettings();
  });
}

els.protectUpperCheck.addEventListener('change', () => {
  if (!currentSettings) return;
  currentSettings.protectUpper = els.protectUpperCheck.checked;
  persistCurrentSettings();
});

// LLM controls
els.llmEnabledToggle.addEventListener('change', () => {
  if (!currentSettings) return;
  currentSettings.llm.enabled = els.llmEnabledToggle.checked;
  persistCurrentSettings();
});

els.llmProvider.addEventListener('change', () => {
  const p = els.llmProvider.value;
  const preset = providerPresets[p];
  if (preset && p !== 'custom') {
    els.llmBaseUrl.value = preset.baseUrl || '';
    els.llmModel.value = preset.defaultModel || '';
  }
});

els.saveLlmBtn.addEventListener('click', async () => {
  if (!currentSettings) return;
  currentSettings.llm = {
    enabled: els.llmEnabledToggle.checked,
    provider: els.llmProvider.value,
    baseUrl: els.llmBaseUrl.value.trim(),
    apiKey: els.llmApiKey.value.trim(),
    model: els.llmModel.value.trim(),
    aggressiveScan: els.llmAggressiveCheck.checked,
  };

  els.saveLlmBtn.disabled = true;
  setStatusMessage(els.llmTestStatus, '已保存配置，正在测试接口连通性…', true);
  await persistCurrentSettings();

  const testRes = await sendMsg({
    type: 'TEST_LLM_CONNECTION',
    llmConfig: currentSettings.llm,
  });
  els.saveLlmBtn.disabled = false;

  if (testRes && testRes.ok) {
    setStatusMessage(els.llmTestStatus, `连接成功 · 延迟 ${testRes.latencyMs}ms`, true);
  } else {
    setStatusMessage(els.llmTestStatus, (testRes && testRes.error) || '连接测试失败', false);
  }
});

// Lists & Custom keywords save
if (els.restorePresetsBtn) {
  els.restorePresetsBtn.addEventListener('click', async () => {
    if (!currentSettings) return;
    const existing = String(els.customKeywordsInput.value || '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    const merged = Array.from(new Set([...existing, ...builtinPresetKeywords]));
    currentSettings.customKeywords = merged;
    currentSettings.useBuiltinPresets = true;
    els.customKeywordsInput.value = merged.join('\n');
    await persistCurrentSettings();
    setStatusMessage(els.listsSaveStatus, `已载入并保存 ${merged.length} 条预设屏蔽词`, true);
  });
}

els.saveListsBtn.addEventListener('click', async () => {
  if (!currentSettings) return;
  const kws = String(els.customKeywordsInput.value || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  currentSettings.customKeywords = kws;
  currentSettings.useBuiltinPresets = kws.length > 0;
  currentSettings.whitelistUids = parseMultilineList(els.whitelistUidsInput.value);
  currentSettings.blacklistUids = parseMultilineList(els.blacklistUidsInput.value);

  await persistCurrentSettings();
  setStatusMessage(els.listsSaveStatus, '名单与自定义规则已保存并同步至页面', true);
  setTimeout(() => setStatusMessage(els.listsSaveStatus, '', true), 2500);
});

els.clearStatsBtn.addEventListener('click', async () => {
  await sendMsg({ type: 'CLEAR_STATS' });
  await refreshPopupData();
  setStatusMessage(els.listsSaveStatus, '累计统计与 API 判定缓存已清空', true);
});

// Initialize popup
(async function bootstrapPopup() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs && tabs[0] && tabs[0].id) {
      activeTabId = tabs[0].id;
    }
  } catch (_e) {
    // ignore
  }
  await refreshPopupData();
})();
