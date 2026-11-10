/**
 * Bili-AI-Killer — MAIN World Controller & Time-Sliced Scheduler (v3.0)
 * Coordinates passive API indexer, targeted Shadow DOM extractor, Constructable Stylesheet
 * collapse banners, cross-tab bot memory, and frame-budgeted evaluation.
 */
(function initMainWorld() {
  'use strict';

  if (window.__BAK_MAIN_ACTIVE__) return;
  Object.defineProperty(window, '__BAK_MAIN_ACTIVE__', {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false,
  });

  const core = window.__BAK_CORE__ || {};
  const detector = core.detector;
  const sniffer = core.sniffer;
  const domExtractor = core.domExtractor;
  try {
    delete window.__BAK_CORE__;
  } catch (_e) {
    // ignore
  }

  if (!detector || !sniffer || !domExtractor) return;

  const EVT_TO_MAIN = 'bak:bridge-to-main';
  const EVT_TO_ISOLATED = 'bak:main-to-bridge';

  let currentSettings = detector.normalizeSettings(detector.DEFAULT_SETTINGS);
  let settingsEpoch = 1;

  const pageContext = {
    currentUserUid: '',
    upperUid: '',
    videoPubdate: 0,
    confirmedBotUids: new Set(),
  };

  const llmVerdictByRpid = new Map();
  const pendingLlmRpids = new Set();
  const syncedBotIdentities = new Set();

  // Map<HTMLElement, TrackedEntry>
  const trackedHosts = new Map();
  const blockedLogRpidSet = new Set();
  const observedRoots = new WeakSet();

  const api = sniffer.createApiIndexer(pageContext, () => {
    scheduleReevaluateTracked(true);
    setTimeout(() => scheduleReevaluateTracked(true), 140);
  });
  api.installNetworkProxies(window);

  function sendToBridge(type, payload = {}) {
    try {
      const detail = JSON.stringify({ type, payload });
      document.documentElement.dispatchEvent(new CustomEvent(EVT_TO_ISOLATED, { detail }));
    } catch (_err) {
      // ignore
    }
  }

  function getMetaIdentityKey(meta) {
    if (!meta) return '';
    if (meta.rpid) return `r:${meta.rpid}`;
    return `f:${meta.uid || meta.uname || ''}|${sniffer.normalizeSnippet(meta.message)}`;
  }

  function refreshInitialStateContext() {
    try {
      const st = window.__INITIAL_STATE__;
      if (st) {
        const vd = st.videoData || st.epInfo || null;
        if (vd) {
          if (vd.pubdate && Number(vd.pubdate) > 0) {
            pageContext.videoPubdate = Number(vd.pubdate);
          }
          const ownerMid = (vd.owner && vd.owner.mid) || vd.mid;
          if (ownerMid) {
            pageContext.upperUid = String(ownerMid);
          }
        }
        if (st.mid && Number(st.mid) > 0) {
          pageContext.currentUserUid = String(st.mid);
        }
      }
      if (!pageContext.currentUserUid && document.cookie) {
        const m = document.cookie.match(/(?:^|;\s*)DedeUserID=(\d+)/);
        if (m && m[1]) {
          pageContext.currentUserUid = m[1];
        }
      }
    } catch (_err) {
      // ignore
    }
  }

  function resolveCommentMeta(rendererEl, threadEl) {
    const rawFromRenderer =
      domExtractor.extractLitCommentPayload(rendererEl) ||
      (threadEl ? domExtractor.extractLitCommentPayload(threadEl) : null);
    if (rawFromRenderer) {
      const indexed = api.indexRawReplyObject(rawFromRenderer);
      if (indexed) return indexed;
    }

    const domFallback = domExtractor.extractShadowDomFallback(rendererEl);
    if (!domFallback) return null;

    const snip = sniffer.normalizeSnippet(domFallback.message);
    if (snip) {
      const byUid = domFallback.uid ? api.metaByFingerprint.get(`u:${domFallback.uid}|${snip}`) : null;
      if (byUid) {
        if (domFallback.__contentNode) {
          Object.defineProperty(byUid, '__contentNode', {
            value: domFallback.__contentNode,
            configurable: true,
            enumerable: false,
          });
        }
        return byUid;
      }
      const byName = domFallback.uname ? api.metaByFingerprint.get(`n:${domFallback.uname}|${snip}`) : null;
      if (byName) {
        if (domFallback.__contentNode) {
          Object.defineProperty(byName, '__contentNode', {
            value: domFallback.__contentNode,
            configurable: true,
            enumerable: false,
          });
        }
        return byName;
      }
    }

    const userProfile =
      (domFallback.uid && api.userByUid.get(domFallback.uid)) ||
      (domFallback.uname && api.userByUname.get(domFallback.uname)) ||
      null;
    if (userProfile) {
      if (!domFallback.uid && userProfile.uid) domFallback.uid = userProfile.uid;
      if (!domFallback.uname && userProfile.uname) domFallback.uname = userProfile.uname;
      if (!domFallback.sign && userProfile.sign) domFallback.sign = userProfile.sign;
      if (!domFallback.level && userProfile.level) domFallback.level = userProfile.level;
    }

    return domFallback;
  }

  function isIdentityWhitelisted(uid, uname) {
    const list = currentSettings.whitelistUids || [];
    if (uid && list.includes(String(uid))) return true;
    if (uname && list.includes(`@${uname}`)) return true;
    return false;
  }

  function ensureCollapseBanner(hostEl, meta, evalResult) {
    const sr = hostEl.shadowRoot;
    if (!sr || !sr.childNodes || sr.childNodes.length === 0) return;

    domExtractor.injectCollapseStyles(sr, document);

    let banner = sr.querySelector('div[data-bak-banner]');
    if (!banner) {
      banner = document.createElement('div');
      banner.setAttribute('data-bak-banner', '1');
      banner.className = 'bak-banner';
      banner.innerHTML = `
        <div class="bak-banner-info">
          <span class="bak-badge"></span>
          <span class="bak-reason-text"></span>
        </div>
        <div class="bak-actions">
          <button type="button" class="bak-btn bak-btn-toggle">展开查看</button>
          <button type="button" class="bak-btn bak-btn-whitelist" title="将该用户加入白名单，不再拦截">误伤加白</button>
        </div>
      `;
      const toggleBtn = banner.querySelector('.bak-btn-toggle');
      const whiteBtn = banner.querySelector('.bak-btn-whitelist');

      toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const cur = hostEl.getAttribute('data-bak-state');
        if (cur === 'collapsed') {
          hostEl.setAttribute('data-bak-state', 'expanded');
          toggleBtn.textContent = '收起评论';
        } else {
          hostEl.setAttribute('data-bak-state', 'collapsed');
          toggleBtn.textContent = '展开查看';
        }
      });

      whiteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const currentEntry = trackedHosts.get(hostEl);
        const targetUid = currentEntry && currentEntry.meta && currentEntry.meta.uid;
        const targetUname = currentEntry && currentEntry.meta && currentEntry.meta.uname;
        if (targetUname) {
          pageContext.confirmedBotUids.delete(`n:${targetUname}`);
        }
        if (targetUid) {
          pageContext.confirmedBotUids.delete(String(targetUid));
        }

        const identityToken = targetUid ? String(targetUid) : targetUname ? `@${targetUname}` : '';
        if (identityToken) {
          if (!currentSettings.whitelistUids.includes(identityToken)) {
            currentSettings.whitelistUids.push(identityToken);
          }
          settingsEpoch += 1;
          sendToBridge('ADD_WHITELIST_UID', {
            uid: targetUid || identityToken,
            uname: targetUname || '',
          });
          scheduleReevaluateTracked(true);
        } else {
          restoreHost(hostEl);
        }
      });

      sr.appendChild(banner);
    }

    const badgeEl = banner.querySelector('.bak-badge');
    const reasonEl = banner.querySelector('.bak-reason-text');
    const whiteBtn = banner.querySelector('.bak-btn-whitelist');
    const toggleBtn = banner.querySelector('.bak-btn-toggle');

    if (badgeEl) {
      badgeEl.textContent = evalResult.categoryLabel || 'AI疑似';
    }
    if (reasonEl) {
      const reasonSummary = (evalResult.reasons || []).slice(0, 2).join(' · ') || '命中AI特征';
      const authorTag = meta && meta.uname ? `@${meta.uname} · ` : '';
      reasonEl.textContent = `已折叠疑似 AI 评论：${authorTag}${reasonSummary}`;
    }
    if (whiteBtn) {
      whiteBtn.style.display = meta && (meta.uid || meta.uname) ? '' : 'none';
    }
    if (toggleBtn && hostEl.getAttribute('data-bak-state') !== 'expanded') {
      toggleBtn.textContent = '展开查看';
    }
  }

  function restoreHost(hostEl) {
    if (!hostEl) return;
    if (hostEl.hasAttribute('data-bak-state')) {
      hostEl.removeAttribute('data-bak-state');
    }
    if (hostEl.style && hostEl.style.display === 'none') {
      hostEl.style.removeProperty('display');
    }
  }

  function applyBlockToHost(hostEl, meta, evalResult) {
    if (!hostEl) return;
    const tag = hostEl.tagName || '';
    if (tag !== 'BILI-COMMENT-THREAD-RENDERER' && tag !== 'BILI-COMMENT-REPLY-RENDERER') {
      return;
    }

    if (currentSettings.displayMode === 'hide') {
      if (hostEl.getAttribute('data-bak-state') !== 'hidden') {
        hostEl.setAttribute('data-bak-state', 'hidden');
      }
      if (!hostEl.style || hostEl.style.display !== 'none') {
        hostEl.style.setProperty('display', 'none', 'important');
      }
    } else {
      if (hostEl.style && hostEl.style.display === 'none') {
        hostEl.style.removeProperty('display');
      }
      ensureCollapseBanner(hostEl, meta, evalResult);
      const curState = hostEl.getAttribute('data-bak-state');
      if (curState !== 'expanded' && curState !== 'collapsed') {
        hostEl.setAttribute('data-bak-state', 'collapsed');
      }
    }

    const logKey =
      (meta && meta.rpid) ||
      `${(meta && meta.uid) || (meta && meta.uname) || ''}:${sniffer.normalizeSnippet(meta && meta.message)}`;
    if (logKey && !blockedLogRpidSet.has(logKey)) {
      blockedLogRpidSet.add(logKey);
      sendToBridge('COMMENT_BLOCKED', {
        rpid: (meta && meta.rpid) || '',
        uid: (meta && meta.uid) || '',
        uname: (meta && meta.uname) || '未知用户',
        sign: (meta && meta.sign) || '',
        snippet: String((meta && meta.message) || '').slice(0, 90),
        score: evalResult.score,
        category: evalResult.primaryCategory,
        categoryLabel: evalResult.categoryLabel || 'AI疑似',
        reasons: evalResult.reasons || [],
        ts: Date.now(),
      });
    }
  }

  function evaluateAndActOnEntry(hostEl, entry) {
    if (!hostEl || !hostEl.isConnected) {
      trackedHosts.delete(hostEl);
      return;
    }

    const currentApiEpoch = api.getApiEpoch();
    let needResolve = !entry.meta || !entry.meta.message || entry.lastApiEpoch !== currentApiEpoch;
    if (!needResolve) {
      const rawPayload =
        domExtractor.extractLitCommentPayload(entry.rendererEl) ||
        (entry.isThread ? domExtractor.extractLitCommentPayload(hostEl) : null);
      if (rawPayload) {
        const rawRpid = String(rawPayload.rpid_str || rawPayload.rpid || '').trim();
        if (rawRpid && entry.meta.rpid && rawRpid !== entry.meta.rpid) {
          needResolve = true;
        }
      } else if (entry.contentNode && entry.contentNode.isConnected) {
        const curText = entry.contentNode.textContent || '';
        if (curText && curText !== entry.lastDomText) {
          needResolve = true;
        }
      }
    }

    if (needResolve) {
      const freshMeta = resolveCommentMeta(entry.rendererEl, entry.isThread ? hostEl : null);
      if (freshMeta) {
        if (freshMeta.__contentNode) {
          entry.contentNode = freshMeta.__contentNode;
          entry.lastDomText = freshMeta.__contentNode.textContent || '';
        }
        const newIdKey = getMetaIdentityKey(freshMeta);
        if (entry.identityKey && newIdKey && entry.identityKey !== newIdKey) {
          restoreHost(hostEl);
          entry.lastEvalKey = '';
          entry.lastResult = null;
        }
        entry.meta = freshMeta;
        entry.identityKey = newIdKey;
        entry.lastApiEpoch = currentApiEpoch;
      } else if (entry.meta && entry.meta.rpid && !entry.meta.sign && api.metaByRpid.has(entry.meta.rpid)) {
        entry.meta = api.metaByRpid.get(entry.meta.rpid);
        entry.lastApiEpoch = currentApiEpoch;
      }
    }

    const meta = entry.meta;
    if (!meta || (!meta.message && !meta.uname && !meta.sign)) {
      if ((entry.retryCount || 0) < 3) {
        entry.retryCount = (entry.retryCount || 0) + 1;
        setTimeout(() => evaluateAndActOnEntry(hostEl, entry), entry.retryCount * 50);
      }
      return;
    }

    if (!currentSettings.enabled) {
      restoreHost(hostEl);
      return;
    }

    let parentThreadIsAi = false;
    let domParentMessage = '';
    if (!entry.isThread && entry.parentThreadEl) {
      const parentEntry = trackedHosts.get(entry.parentThreadEl);
      if (parentEntry) {
        if (parentEntry.lastResult && parentEntry.lastResult.action === 'block') {
          parentThreadIsAi = true;
        }
        if (parentEntry.meta && parentEntry.meta.message) {
          domParentMessage = parentEntry.meta.message;
        }
      }
    }

    const apiParentCtx = api.getParentContext(meta);
    const parentMessage = apiParentCtx.parentMessage || domParentMessage;
    const threadBotCadence = apiParentCtx.threadBotCadence;

    const llmVerdict = meta.rpid ? llmVerdictByRpid.get(meta.rpid) : null;
    const whitelisted = isIdentityWhitelisted(meta.uid, meta.uname);
    const isConfirmedBot =
      !whitelisted &&
      Boolean(
        (meta.uid && pageContext.confirmedBotUids.has(String(meta.uid))) ||
          (meta.uname && pageContext.confirmedBotUids.has(`n:${meta.uname}`))
      );

    const evalKey = `${meta.rpid}|${meta.uid}|${meta.uname}|${(meta.sign || '').length}|${(meta.message || '').length}|${isConfirmedBot ? 1 : 0}|${parentThreadIsAi ? 1 : 0}|${threadBotCadence ? 1 : 0}|${llmVerdict ? Number(llmVerdict.isAi) : -1}|${settingsEpoch}`;

    if (entry.lastEvalKey === evalKey && entry.lastResult) {
      if (entry.lastResult.action === 'block') {
        applyBlockToHost(hostEl, meta, entry.lastResult);
      } else {
        restoreHost(hostEl);
      }
      return;
    }

    if (!pageContext.upperUid || !pageContext.videoPubdate) {
      refreshInitialStateContext();
    }

    const effectiveContext = {
      currentUserUid: pageContext.currentUserUid,
      upperUid: pageContext.upperUid,
      videoPubdate: pageContext.videoPubdate,
      confirmedBotUids: pageContext.confirmedBotUids,
      parentThreadIsAi,
      parentMessage,
      threadBotCadence,
    };

    const res = isConfirmedBot
      ? {
          action: 'block',
          score: 95,
          threshold: 55,
          primaryCategory: 'persona_dafeiyu',
          categoryLabel: '同号AI实锤',
          reasons: ['该账号已被实锤为AI挂机号'],
          confirmUidAsBot: true,
        }
      : detector.evaluateComment(meta, currentSettings, effectiveContext);

    entry.lastEvalKey = evalKey;
    entry.lastResult = res;

    if (res.confirmUidAsBot) {
      let addedNew = false;
      if (meta.uid && !pageContext.confirmedBotUids.has(String(meta.uid))) {
        pageContext.confirmedBotUids.add(String(meta.uid));
        addedNew = true;
      }
      if (meta.uname && !pageContext.confirmedBotUids.has(`n:${meta.uname}`)) {
        pageContext.confirmedBotUids.add(`n:${meta.uname}`);
        addedNew = true;
      }
      // Persist hard-confirmed bot identities across tabs (session-scoped)
      if (res.score >= 78 && meta.uid && !syncedBotIdentities.has(meta.uid)) {
        syncedBotIdentities.add(meta.uid);
        sendToBridge('RECORD_CONFIRMED_BOT', { uid: meta.uid, uname: meta.uname || '' });
      }
      if (addedNew) {
        scheduleReevaluateTracked(false);
      }
    }

    if (res.action === 'block') {
      applyBlockToHost(hostEl, meta, res);
      return;
    }

    if (llmVerdict) {
      if (llmVerdict.isAi) {
        if (llmVerdict.confirmUid && meta.uid) {
          pageContext.confirmedBotUids.add(String(meta.uid));
        }
        const llmBlockResult = {
          action: 'block',
          score: Math.max(res.score, res.threshold),
          primaryCategory: llmVerdict.category || 'llm_judge',
          categoryLabel: 'API精判',
          reasons: [llmVerdict.reason || '大模型判定为AI生成评论'],
        };
        entry.lastResult = llmBlockResult;
        applyBlockToHost(hostEl, meta, llmBlockResult);
        return;
      }
      restoreHost(hostEl);
      return;
    }

    if (res.action === 'pending_llm' && meta.rpid && !pendingLlmRpids.has(meta.rpid)) {
      pendingLlmRpids.add(meta.rpid);
      sendToBridge('QUEUE_LLM_CHECK', {
        rpid: meta.rpid,
        uid: meta.uid || '',
        uname: meta.uname || '',
        sign: meta.sign || '',
        message: String(meta.message || '').slice(0, 320),
        localScore: res.score,
        localReasons: res.reasons || [],
      });
    }

    restoreHost(hostEl);
  }

  // Time-sliced frame-budget scheduler: fast synchronous first batch, yields if > 4.5ms
  const FRAME_BUDGET_MS = 4.5;
  let reevalScheduled = false;
  let pendingFullRescan = false;
  let sliceTimer = null;

  function nowMs() {
    return typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();
  }

  function runSlicedEntries(entriesList, startIndex) {
    sliceTimer = null;
    const start = nowMs();
    for (let i = startIndex; i < entriesList.length; i++) {
      const [hostEl, entry] = entriesList[i];
      evaluateAndActOnEntry(hostEl, entry);
      if (i - startIndex >= 24 && nowMs() - start > FRAME_BUDGET_MS && i + 1 < entriesList.length) {
        const scheduleNext =
          typeof requestAnimationFrame === 'function'
            ? requestAnimationFrame
            : (fn) => setTimeout(fn, 16);
        sliceTimer = scheduleNext(() => runSlicedEntries(entriesList, i + 1));
        return;
      }
    }
  }

  function scheduleReevaluateTracked(forceFullRescan = false) {
    if (forceFullRescan) pendingFullRescan = true;
    if (reevalScheduled) return;
    reevalScheduled = true;
    queueMicrotask(() => {
      reevalScheduled = false;
      const doFull = pendingFullRescan;
      pendingFullRescan = false;
      if (doFull) {
        scanBiliCommentsTree();
      } else {
        const snapshot = Array.from(trackedHosts.entries());
        runSlicedEntries(snapshot, 0);
      }
    });
  }

  function processThreadRenderer(threadEl) {
    if (!threadEl || !threadEl.shadowRoot) return;
    ensureObserved(threadEl.shadowRoot);

    const mainCommentRenderer = threadEl.shadowRoot.querySelector('bili-comment-renderer');
    if (mainCommentRenderer) {
      let entry = trackedHosts.get(threadEl);
      if (!entry) {
        entry = {
          rendererEl: mainCommentRenderer,
          parentThreadEl: null,
          isThread: true,
          meta: null,
          contentNode: null,
          lastDomText: '',
          lastApiEpoch: 0,
          retryCount: 0,
          identityKey: '',
          lastEvalKey: '',
          lastResult: null,
        };
        trackedHosts.set(threadEl, entry);
      } else {
        entry.rendererEl = mainCommentRenderer;
      }
      evaluateAndActOnEntry(threadEl, entry);
    }

    const repliesRenderer = threadEl.shadowRoot.querySelector('bili-comment-replies-renderer');
    if (repliesRenderer && repliesRenderer.shadowRoot) {
      ensureObserved(repliesRenderer.shadowRoot);
      const replyEls = repliesRenderer.shadowRoot.querySelectorAll('bili-comment-reply-renderer');
      for (const replyEl of replyEls) {
        processReplyRenderer(replyEl, threadEl);
      }
    }
  }

  function processReplyRenderer(replyEl, parentThreadEl = null) {
    if (!replyEl) return;
    let resolvedParentThread = parentThreadEl;
    if (!resolvedParentThread) {
      const owner = findOwningCommentHost(replyEl.getRootNode && replyEl.getRootNode());
      if (owner && owner.tagName === 'BILI-COMMENT-THREAD-RENDERER') {
        resolvedParentThread = owner;
      }
    }

    let entry = trackedHosts.get(replyEl);
    if (!entry) {
      entry = {
        rendererEl: replyEl,
        parentThreadEl: resolvedParentThread,
        isThread: false,
        meta: null,
        contentNode: null,
        lastDomText: '',
        lastApiEpoch: 0,
        retryCount: 0,
        identityKey: '',
        lastEvalKey: '',
        lastResult: null,
      };
      trackedHosts.set(replyEl, entry);
    } else if (resolvedParentThread && !entry.parentThreadEl) {
      entry.parentThreadEl = resolvedParentThread;
    }
    evaluateAndActOnEntry(replyEl, entry);
  }

  function findOwningCommentHost(shadowRoot) {
    let curRoot = shadowRoot;
    for (let i = 0; i < 6 && curRoot && curRoot.host; i++) {
      const host = curRoot.host;
      const tag = host.tagName || '';
      if (tag === 'BILI-COMMENT-REPLY-RENDERER' || tag === 'BILI-COMMENT-THREAD-RENDERER') {
        return host;
      }
      curRoot = host.getRootNode && host.getRootNode();
    }
    return null;
  }

  function inspectNodeTree(rootNode) {
    if (!rootNode) return;
    let isBiliCustomTag = false;
    if (rootNode.nodeType === 1) {
      const tag = rootNode.tagName || '';
      isBiliCustomTag = tag.startsWith('BILI-');
      if (tag === 'BILI-COMMENTS') {
        if (rootNode.shadowRoot) {
          ensureObserved(rootNode.shadowRoot);
          inspectNodeTree(rootNode.shadowRoot);
        }
      } else if (tag === 'BILI-COMMENT-THREAD-RENDERER') {
        processThreadRenderer(rootNode);
        return;
      } else if (tag === 'BILI-COMMENT-REPLIES-RENDERER') {
        if (rootNode.shadowRoot) {
          ensureObserved(rootNode.shadowRoot);
          inspectNodeTree(rootNode.shadowRoot);
        }
        return;
      } else if (tag === 'BILI-COMMENT-REPLY-RENDERER') {
        processReplyRenderer(rootNode);
        return;
      } else if (tag === 'BILI-COMMENT-RENDERER') {
        const hostRoot = rootNode.getRootNode && rootNode.getRootNode();
        if (hostRoot && hostRoot.host && hostRoot.host.tagName === 'BILI-COMMENT-THREAD-RENDERER') {
          processThreadRenderer(hostRoot.host);
        }
        return;
      } else if (tag === 'BILI-RICH-TEXT' || tag === 'BILI-COMMENT-USER-INFO') {
        const owningHost = findOwningCommentHost(rootNode.getRootNode && rootNode.getRootNode());
        if (owningHost) {
          if (owningHost.tagName === 'BILI-COMMENT-REPLY-RENDERER') {
            processReplyRenderer(owningHost);
          } else {
            processThreadRenderer(owningHost);
          }
        }
        return;
      }
    }

    if (
      !isBiliCustomTag &&
      rootNode.nodeType === 1 &&
      rootNode.childNodes &&
      rootNode.childNodes.length === 0
    ) {
      return;
    }

    if (rootNode.querySelectorAll) {
      const candidates = rootNode.querySelectorAll(
        'bili-comments, bili-comment-thread-renderer, bili-comment-replies-renderer, bili-comment-reply-renderer'
      );
      for (const el of candidates) {
        if (el.tagName === 'BILI-COMMENTS' && el.shadowRoot) {
          ensureObserved(el.shadowRoot);
        } else if (el.tagName === 'BILI-COMMENT-REPLIES-RENDERER' && el.shadowRoot) {
          ensureObserved(el.shadowRoot);
        } else if (el.tagName === 'BILI-COMMENT-THREAD-RENDERER') {
          processThreadRenderer(el);
        } else if (el.tagName === 'BILI-COMMENT-REPLY-RENDERER') {
          processReplyRenderer(el);
        }
      }
    }
  }

  function ensureObserved(shadowRoot) {
    if (!shadowRoot || observedRoots.has(shadowRoot)) return;
    observedRoots.add(shadowRoot);

    const obs = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const added of m.addedNodes) {
          if (added.nodeType === 1) {
            if (
              added.hasAttribute &&
              (added.hasAttribute('data-bak-banner') || added.hasAttribute('data-bak-style'))
            ) {
              continue;
            }
            inspectNodeTree(added);
          }
        }
      }
    });
    obs.observe(shadowRoot, { childList: true, subtree: true });
  }

  function scanBiliCommentsTree() {
    if (!document || !document.querySelectorAll) return false;
    const allCommentRoots = document.querySelectorAll('bili-comments');
    let foundReadyRoot = false;
    for (const bc of allCommentRoots) {
      if (!bc.shadowRoot) continue;
      foundReadyRoot = true;
      ensureObserved(bc.shadowRoot);
      const threads = bc.shadowRoot.querySelectorAll('bili-comment-thread-renderer');
      for (const threadEl of threads) {
        processThreadRenderer(threadEl);
      }
    }
    return foundReadyRoot;
  }

  let activeDocObs = null;
  function setupDocumentObserver() {
    if (scanBiliCommentsTree()) {
      if (activeDocObs) {
        activeDocObs.disconnect();
        activeDocObs = null;
      }
      return;
    }

    const target = document.body || document.documentElement;
    if (!target || activeDocObs) return;

    let docCheckQueued = false;
    activeDocObs = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const added of m.addedNodes) {
          if (added.nodeType === 1 && added.tagName === 'BILI-COMMENTS') {
            inspectNodeTree(added);
            if (added.shadowRoot && activeDocObs) {
              activeDocObs.disconnect();
              activeDocObs = null;
              return;
            }
          }
        }
      }
      if (docCheckQueued) return;
      docCheckQueued = true;
      setTimeout(() => {
        docCheckQueued = false;
        if (scanBiliCommentsTree() && activeDocObs) {
          activeDocObs.disconnect();
          activeDocObs = null;
        }
      }, 120);
    });
    activeDocObs.observe(target, { childList: true, subtree: true });
  }

  let scrollTimer = null;
  window.addEventListener(
    'scroll',
    () => {
      if (scrollTimer) return;
      scrollTimer = setTimeout(() => {
        scrollTimer = null;
        scheduleReevaluateTracked(true);
      }, 280);
    },
    { passive: true }
  );

  let lastPathname = location.pathname + location.search;
  setInterval(() => {
    const nowPath = location.pathname + location.search;
    if (nowPath !== lastPathname) {
      lastPathname = nowPath;
      blockedLogRpidSet.clear();
      pendingLlmRpids.clear();
      pageContext.upperUid = '';
      pageContext.videoPubdate = 0;
      settingsEpoch += 1;
      refreshInitialStateContext();
      sendToBridge('PAGE_RESET', { url: location.href });
      setupDocumentObserver();
      return;
    }
    if (!activeDocObs) {
      const bc = document.querySelector && document.querySelector('bili-comments');
      if (bc && bc.shadowRoot && !observedRoots.has(bc.shadowRoot)) {
        scanBiliCommentsTree();
      }
    }
  }, 1800);

  document.documentElement.addEventListener(EVT_TO_MAIN, (ev) => {
    if (!ev || typeof ev.detail !== 'string') return;
    try {
      const msg = JSON.parse(ev.detail);
      if (!msg || !msg.type) return;

      if (msg.type === 'SYNC_SETTINGS') {
        currentSettings = detector.normalizeSettings(msg.payload);
        if (Array.isArray(msg.confirmedBots)) {
          for (const bUid of msg.confirmedBots) {
            if (bUid) pageContext.confirmedBotUids.add(String(bUid));
          }
        }
        for (const token of currentSettings.whitelistUids) {
          if (token.startsWith('@')) {
            pageContext.confirmedBotUids.delete(`n:${token.slice(1)}`);
          } else {
            pageContext.confirmedBotUids.delete(token);
          }
        }
        settingsEpoch += 1;
        scheduleReevaluateTracked(true);
      } else if (msg.type === 'SYNC_CONFIRMED_BOTS') {
        const list = Array.isArray(msg.payload) ? msg.payload : [];
        let changed = false;
        for (const bUid of list) {
          const s = String(bUid || '').trim();
          if (s && !pageContext.confirmedBotUids.has(s) && !isIdentityWhitelisted(s, '')) {
            pageContext.confirmedBotUids.add(s);
            changed = true;
          }
        }
        if (changed) {
          settingsEpoch += 1;
          scheduleReevaluateTracked(false);
        }
      } else if (msg.type === 'LLM_VERDICTS') {
        const verdicts = Array.isArray(msg.payload) ? msg.payload : [];
        for (const v of verdicts) {
          if (v && v.rpid) {
            pendingLlmRpids.delete(String(v.rpid));
            sniffer.lruSet(llmVerdictByRpid, String(v.rpid), v, 2000);
          }
        }
        settingsEpoch += 1;
        scheduleReevaluateTracked(false);
      }
    } catch (_err) {
      // ignore
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      refreshInitialStateContext();
      setupDocumentObserver();
    });
  } else {
    refreshInitialStateContext();
    setupDocumentObserver();
  }

  sendToBridge('MAIN_READY', { url: location.href });
})();
