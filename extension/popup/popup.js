/**
 * Bili-AI-Killer — Popup Control Center Logic (v3.0)
 */

const SENSITIVITY_HINTS = {
  relaxed: '阈值 75 · 仅拦截高确信度AI号',
  standard: '阈值 55 · 平衡识别与防误伤',
  strict: '阈值 40 · 强力猎杀伪装DeepSeek腔',
};

let activeTabId = -1;
let currentSettings = null;
let currentStats = null;
let currentTabState = null;
let providerPresets = {};
let builtinPresetKeywords = [];
let categoryMeta = {};

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
  catBreakdown: document.getElementById('cat-breakdown'),
  logsFilterInput: document.getElementById('logs-filter-input'),
  logsContainer: document.getElementById('logs-container'),
  llmEnabledToggle: document.getElementById('llm-enabled-toggle'),
  llmProvider: document.getElementById('llm-provider'),
  llmBaseUrl: document.getElementById('llm-base-url'),
  llmApiKey: document.getElementById('llm-api-key'),
  llmModel: document.getElementById('llm-model'),
  llmAggressiveCheck: document.getElementById('llm-aggressive-check'),
  saveLlmBtn: document.getElementById('save-llm-btn'),
  llmTestStatus: document.getElementById('llm-test-status'),
  presetCountLabel: document.getElementById('preset-count-label'),
  customKeywordsInput: document.getElementById('custom-keywords-input'),
  restorePresetsBtn: document.getElementById('restore-presets-btn'),
  whitelistUidsInput: document.getElementById('whitelist-uids-input'),
  blacklistUidsInput: document.getElementById('blacklist-uids-input'),
  saveListsBtn: document.getElementById('save-lists-btn'),
  exportCfgBtn: document.getElementById('export-cfg-btn'),
  importCfgBtn: document.getElementById('import-cfg-btn'),
  importCfgFile: document.getElementById('import-cfg-file'),
  clearStatsBtn: document.getElementById('clear-stats-btn'),
  listsSaveStatus: document.getElementById('lists-save-status'),
  sampleUname: document.getElementById('sample-uname'),
  sampleSign: document.getElementById('sample-sign'),
  sampleMessage: document.getElementById('sample-message'),
  runSampleBtn: document.getElementById('run-sample-btn'),
  sampleResult: document.getElementById('sample-result'),
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

  if (els.presetCountLabel && builtinPresetKeywords.length > 0) {
    els.presetCountLabel.innerHTML = `屏蔽词库（每行一条，支持关键字或 <code>/正则/i</code>，内置 ${builtinPresetKeywords.length} 条推荐词）`;
  }

  els.customKeywordsInput.value = (settings.customKeywords || []).join('\n');
  els.whitelistUidsInput.value = (settings.whitelistUids || []).join('\n');
  els.blacklistUidsInput.value = (settings.blacklistUids || []).join('\n');
}

function renderCategoryBreakdown(stats) {
  if (!els.catBreakdown) return;
  els.catBreakdown.replaceChildren();
  const byCat = (stats && stats.byCategory) || {};
  const entries = Object.entries(byCat).filter(([, count]) => Number(count) > 0);
  if (entries.length === 0) return;

  entries.sort((a, b) => Number(b[1]) - Number(a[1]));
  for (const [catId, count] of entries) {
    const chip = document.createElement('span');
    chip.className = 'cat-chip';
    const label = (categoryMeta[catId] && categoryMeta[catId].shortLabel) || catId;
    const valEl = document.createElement('strong');
    valEl.textContent = String(count);
    chip.append(document.createTextNode(label), valEl);
    els.catBreakdown.appendChild(chip);
  }
}

function renderStatsAndLogs(stats, tabState) {
  const tabCount = Number(tabState && tabState.count) || 0;
  const totalCount = Number(stats && stats.totalBlocked) || 0;
  els.statTabCount.textContent = String(tabCount);
  els.statTotalCount.textContent = String(totalCount);
  els.logsPill.textContent = String(tabCount);

  renderCategoryBreakdown(stats);

  const rawLogs = (tabState && Array.isArray(tabState.logs) && tabState.logs) || [];
  const query = String((els.logsFilterInput && els.logsFilterInput.value) || '')
    .trim()
    .toLowerCase();

  const logs = query
    ? rawLogs.filter((item) => {
        const hay = `${item.uname || ''} ${item.uid || ''} ${item.snippet || ''} ${(item.reasons || []).join(' ')}`.toLowerCase();
        return hay.includes(query);
      })
    : rawLogs;

  els.logsContainer.replaceChildren();

  if (logs.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = query ? '没有匹配搜索条件的拦截记录' : '当前页面暂未发现或拦截 AI 评论';
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
    tag.textContent = `${item.categoryLabel || 'AI疑似'} · ${item.score || 0}分`;

    top.append(author, tag);

    const snippet = document.createElement('div');
    snippet.className = 'log-snippet';
    snippet.textContent = item.snippet || (item.sign ? `[签名] ${item.sign}` : '(无正文摘要)');

    const foot = document.createElement('div');
    foot.className = 'log-foot';

    const reasons = document.createElement('span');
    reasons.className = 'log-reasons';
    reasons.textContent = (item.reasons || []).join(' · ') || '命中AI特征';
    foot.appendChild(reasons);

    if (item.uid || (item.uname && item.uname !== '未知用户')) {
      const whiteBtn = document.createElement('button');
      whiteBtn.type = 'button';
      whiteBtn.className = 'whitelist-mini-btn';
      whiteBtn.textContent = '误伤加白';
      whiteBtn.addEventListener('click', async () => {
        whiteBtn.disabled = true;
        await sendMsg({
          type: 'ADD_WHITELIST_UID',
          tabId: activeTabId,
          uid: item.uid || `@${item.uname}`,
          uname: item.uname || '',
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
  currentStats = resp.stats;
  currentTabState = resp.tabState;
  providerPresets = resp.presets || {};
  builtinPresetKeywords = Array.isArray(resp.builtinPresets) ? resp.builtinPresets : [];
  categoryMeta = resp.categoryMeta || {};
  renderSettingsToUI(currentSettings);
  renderStatsAndLogs(currentStats, currentTabState);
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

if (els.logsFilterInput) {
  els.logsFilterInput.addEventListener('input', () => {
    renderStatsAndLogs(currentStats, currentTabState);
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

// Presets & Lists
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
  setStatusMessage(els.listsSaveStatus, '规则与名单已保存并实时同步至页面', true);
  setTimeout(() => setStatusMessage(els.listsSaveStatus, '', true), 2500);
});

// Export / Import config
if (els.exportCfgBtn) {
  els.exportCfgBtn.addEventListener('click', () => {
    if (!currentSettings) return;
    const safeExport = JSON.parse(JSON.stringify(currentSettings));
    if (safeExport.llm) safeExport.llm.apiKey = '';
    const blob = new Blob([JSON.stringify(safeExport, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'bili-ai-killer-config.json';
    a.click();
    URL.revokeObjectURL(url);
    setStatusMessage(els.listsSaveStatus, '配置已导出（已自动剔除敏感 API Key）', true);
  });
}

if (els.importCfgBtn && els.importCfgFile) {
  els.importCfgBtn.addEventListener('click', () => els.importCfgFile.click());
  els.importCfgFile.addEventListener('change', async (ev) => {
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const imported = JSON.parse(text);
      if (!imported || typeof imported !== 'object') throw new Error('格式无效');
      if (currentSettings && currentSettings.llm && currentSettings.llm.apiKey && (!imported.llm || !imported.llm.apiKey)) {
        imported.llm = { ...(imported.llm || {}), apiKey: currentSettings.llm.apiKey };
      }
      currentSettings = { ...currentSettings, ...imported };
      await persistCurrentSettings();
      setStatusMessage(els.listsSaveStatus, '配置导入成功并已生效', true);
    } catch (_err) {
      setStatusMessage(els.listsSaveStatus, '导入失败：请选择有效的 JSON 配置文件', false);
    } finally {
      els.importCfgFile.value = '';
    }
  });
}

els.clearStatsBtn.addEventListener('click', async () => {
  await sendMsg({ type: 'CLEAR_STATS' });
  await refreshPopupData();
  setStatusMessage(els.listsSaveStatus, '统计、已实锤号缓存与 API 缓存已清空', true);
});

// Live Rule Tester
if (els.runSampleBtn) {
  els.runSampleBtn.addEventListener('click', async () => {
    const uname = els.sampleUname.value.trim();
    const sign = els.sampleSign.value.trim();
    const message = els.sampleMessage.value.trim();
    if (!uname && !sign && !message) {
      els.sampleResult.hidden = false;
      els.sampleResult.className = 'sample-result';
      els.sampleResult.textContent = '请先输入昵称、签名或待测评论正文。';
      return;
    }
    const resp = await sendMsg({
      type: 'EVALUATE_SAMPLE',
      sample: { uname, sign, message },
    });
    if (!resp || !resp.ok || !resp.verdict) return;
    const v = resp.verdict;
    els.sampleResult.hidden = false;
    const isBlock = v.action === 'block';
    els.sampleResult.className = `sample-result ${isBlock ? 'blocked' : 'allowed'}`;
    const actionText =
      v.action === 'block'
        ? `拦截 (${v.categoryLabel || 'AI'})`
        : v.action === 'pending_llm'
          ? '灰区疑似 (将送 API 复核)'
          : '正常放行';
    const reasonText = (v.reasons || []).join('；') || '未命中 AI 特征';
    els.sampleResult.textContent = `判定：${actionText} ｜ 得分：${v.score} / 阈值 ${v.threshold} ｜ 依据：${reasonText}`;
  });
}

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
