/**
 * Bili-AI-Killer — MAIN World Controller (v2.1 Non-Intrusive & Deep-Scan Fixed)
 * Key Guarantees:
 *  1. ZERO Element.prototype.attachShadow hijacking — never interrupts LitElement constructors.
 *  2. Separate ensureObserved() vs scanBiliCommentsTree() so deep Shadow DOM rescanning NEVER short-circuits.
 *  3. Author profile extraction strictly scoped to bili-comment-user-info (never confused by @mentions in rich text).
 *  4. User-level cache (userByUid / userByUname) links API member.sign to DOM nodes even when rpid is absent.
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
  try {
    delete window.__BAK_CORE__;
  } catch (_e) {
    // ignore
  }

  if (!detector) return;

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

  const MAX_META_CACHE = 4000;
  const metaByRpid = new Map();
  const metaByFingerprint = new Map();
  const userByUid = new Map(); // uid -> { uid, uname, sign }
  const userByUname = new Map(); // uname -> { uid, uname, sign }
  const llmVerdictByRpid = new Map();
  const pendingLlmRpids = new Set();

  // Map<HTMLElement, { rendererEl, parentThreadEl, isThread, meta, identityKey, lastEvalKey, lastResult }>
  const trackedHosts = new Map();
  const blockedLogRpidSet = new Set();
  const observedRoots = new WeakSet();

  function sendToBridge(type, payload = {}) {
    try {
      const detail = JSON.stringify({ type, payload });
      document.documentElement.dispatchEvent(new CustomEvent(EVT_TO_ISOLATED, { detail }));
    } catch (_err) {
      // ignore
    }
  }

  function lruSet(map, key, val, maxSize = MAX_META_CACHE) {
    if (!key) return;
    if (map.has(key)) map.delete(key);
    map.set(key, val);
    if (map.size > maxSize) {
      const oldestKey = map.keys().next().value;
      map.delete(oldestKey);
    }
  }

  function normalizeSnippet(str) {
    return String(str || '')
      .replace(/^回复\s*@[^:：\s]+\s*[：:]\s*/, '')
      .replace(/\s+/g, '')
      .slice(0, 36);
  }

  function getMetaIdentityKey(meta) {
    if (!meta) return '';
    if (meta.rpid) return `r:${meta.rpid}`;
    return `f:${meta.uid || meta.uname || ''}|${normalizeSnippet(meta.message)}`;
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

  function indexRawReplyObject(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const rpid = String(raw.rpid_str || raw.rpid || '').trim();
    const member = raw.member || {};
    const content = raw.content || {};
    const uid = String(member.mid || raw.mid_str || raw.mid || '').trim();
    const uname = String(member.uname || '').trim();
    const sign = String(member.sign || '').trim();
    const message = String(content.message || '').trim();
    const ctime = Number(raw.ctime) || 0;

    if (uid || uname) {
      const profileEntry = { uid, uname, sign };
      if (uid) lruSet(userByUid, uid, profileEntry);
      if (uname) lruSet(userByUname, uname, profileEntry);
    }

    const atNames = [];
    if (Array.isArray(content.members)) {
      for (const m of content.members) {
        if (m && m.uname) atNames.push(String(m.uname));
      }
    } else if (content.at_name_to_mid && typeof content.at_name_to_mid === 'object') {
      atNames.push(...Object.keys(content.at_name_to_mid));
    }

    if (!rpid && !message && !uid) return null;

    const existing = rpid ? metaByRpid.get(rpid) : null;
    const merged = {
      rpid: rpid || (existing && existing.rpid) || '',
      uid: uid || (existing && existing.uid) || '',
      uname: uname || (existing && existing.uname) || '',
      sign: sign || (existing && existing.sign) || '',
      message: message || (existing && existing.message) || '',
      ctime: ctime || (existing && existing.ctime) || 0,
      atNames: atNames.length > 0 ? atNames : (existing && existing.atNames) || [],
    };

    if (merged.rpid) {
      lruSet(metaByRpid, merged.rpid, merged);
    }
    const snip = normalizeSnippet(merged.message);
    if (snip) {
      if (merged.uid) lruSet(metaByFingerprint, `u:${merged.uid}|${snip}`, merged);
      if (merged.uname) lruSet(metaByFingerprint, `n:${merged.uname}|${snip}`, merged);
    }

    if (Array.isArray(raw.replies)) {
      for (const sub of raw.replies) {
        indexRawReplyObject(sub);
      }
    }

    return merged;
  }

  function handleInterceptedApiJson(url, json) {
    if (!json || typeof json !== 'object' || json.code !== 0 || !json.data) return;
    const data = json.data;

    if (url.includes('/x/web-interface/nav')) {
      if (data.mid) pageContext.currentUserUid = String(data.mid);
      return;
    }

    if (url.includes('/x/web-interface/view')) {
      if (data.pubdate) pageContext.videoPubdate = Number(data.pubdate);
      if (data.owner && data.owner.mid) pageContext.upperUid = String(data.owner.mid);
      return;
    }

    if (url.includes('/x/v2/reply/')) {
      if (data.upper && data.upper.mid) {
        pageContext.upperUid = String(data.upper.mid);
      }

      const collections = [
        data.replies,
        data.top_replies,
        data.hots,
        data.dialog && data.dialog.replies,
      ];
      for (const list of collections) {
        if (Array.isArray(list)) {
          for (const item of list) {
            indexRawReplyObject(item);
          }
        }
      }
      if (data.top && typeof data.top === 'object') {
        if (data.top.upper) indexRawReplyObject(data.top.upper);
        if (data.top.admin) indexRawReplyObject(data.top.admin);
        if (data.top.vote) indexRawReplyObject(data.top.vote);
      }
      if (data.root && typeof data.root === 'object') {
        indexRawReplyObject(data.root);
      }

      scheduleReevaluateTracked(true);
      setTimeout(() => scheduleReevaluateTracked(true), 80);
      setTimeout(() => scheduleReevaluateTracked(true), 250);
    }
  }

  function shouldInspectUrl(url) {
    if (!url || typeof url !== 'string') return false;
    return (
      url.includes('/x/v2/reply/') ||
      url.includes('/x/web-interface/nav') ||
      url.includes('/x/web-interface/view')
    );
  }

  // Transparent Proxy on window.fetch (preserves fetch.name & Function.prototype.toString -> [native code])
  if (typeof window.fetch === 'function' && typeof Proxy === 'function') {
    try {
      window.fetch = new Proxy(window.fetch, {
        apply(target, thisArg, args) {
          let url = '';
          try {
            const input = args[0];
            url =
              typeof input === 'string'
                ? input
                : (input && (input.url || input.href)) || '';
          } catch (_e) {
            url = '';
          }
          const resultPromise = Reflect.apply(target, thisArg, args);
          if (shouldInspectUrl(url) && resultPromise && typeof resultPromise.then === 'function') {
            resultPromise
              .then((resp) => {
                if (resp && resp.ok && typeof resp.clone === 'function') {
                  try {
                    const cloned = resp.clone();
                    setTimeout(() => {
                      cloned
                        .json()
                        .then((json) => handleInterceptedApiJson(url, json))
                        .catch(() => {});
                    }, 0);
                  } catch (_e2) {
                    // ignore
                  }
                }
              })
              .catch(() => {});
          }
          return resultPromise;
        },
      });
    } catch (_err) {
      // ignore
    }
  }

  // Transparent Proxy on XMLHttpRequest.prototype.open & send
  if (typeof XMLHttpRequest === 'function' && XMLHttpRequest.prototype && typeof Proxy === 'function') {
    try {
      const urlMap = new WeakMap();
      XMLHttpRequest.prototype.open = new Proxy(XMLHttpRequest.prototype.open, {
        apply(target, thisArg, args) {
          try {
            const rawUrl = args[1];
            const urlStr = typeof rawUrl === 'string' ? rawUrl : String((rawUrl && rawUrl.href) || rawUrl || '');
            if (shouldInspectUrl(urlStr)) {
              urlMap.set(thisArg, urlStr);
            }
          } catch (_e) {
            // ignore
          }
          return Reflect.apply(target, thisArg, args);
        },
      });

      XMLHttpRequest.prototype.send = new Proxy(XMLHttpRequest.prototype.send, {
        apply(target, thisArg, args) {
          const targetUrl = urlMap.get(thisArg);
          if (targetUrl && thisArg && typeof thisArg.addEventListener === 'function') {
            thisArg.addEventListener(
              'loadend',
              function onXhrLoadEnd() {
                setTimeout(() => {
                  try {
                    if (this.responseType === 'json' && this.response) {
                      handleInterceptedApiJson(targetUrl, this.response);
                    } else if (
                      (!this.responseType || this.responseType === 'text') &&
                      typeof this.responseText === 'string' &&
                      this.responseText.startsWith('{')
                    ) {
                      handleInterceptedApiJson(targetUrl, JSON.parse(this.responseText));
                    }
                  } catch (_e) {
                    // ignore
                  }
                }, 0);
              },
              { once: true }
            );
          }
          return Reflect.apply(target, thisArg, args);
        },
      });
    } catch (_err) {
      // ignore
    }
  }

  function extractLitCommentPayload(el) {
    if (!el || typeof el !== 'object') return null;

    const looksLikeReply = (obj) =>
      Boolean(
        obj &&
          typeof obj === 'object' &&
          (obj.rpid || obj.rpid_str || (obj.content && typeof obj.content.message === 'string'))
      );

    try {
      if (el.__data && typeof el.__data === 'object') {
        if (looksLikeReply(el.__data.data)) return el.__data.data;
        if (looksLikeReply(el.__data.reply)) return el.__data.reply;
        if (looksLikeReply(el.__data)) return el.__data;
      }
      if (looksLikeReply(el.data)) return el.data;
      if (looksLikeReply(el._data)) return el._data;
    } catch (_e) {
      // ignore
    }
    return null;
  }

  function extractTextWithAlt(container) {
    if (!container) return '';
    let out = '';
    const walk = (node) => {
      if (!node) return;
      if (node.nodeType === Node.TEXT_NODE) {
        out += node.nodeValue || '';
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        if (node.tagName === 'IMG') {
          const alt = node.getAttribute('alt') || '';
          if (alt) out += alt;
        } else if (node.tagName === 'BR') {
          out += '\n';
        } else {
          for (const ch of node.childNodes) walk(ch);
        }
      }
    };
    walk(container);
    return out.trim();
  }

  /**
   * Extracts uid, uname, and comment message from a renderer's Shadow DOM.
   * Ensures @mentions inside <bili-rich-text> are NEVER mistaken for the comment author's uname/uid.
   */
  function extractShadowDomFallback(rendererEl) {
    if (!rendererEl || !rendererEl.shadowRoot) return null;
    let uid = '';
    let uname = '';
    let message = '';

    const extractAuthorFromRoot = (root) => {
      if (!root || !root.querySelectorAll) return;
      const anchors = root.querySelectorAll(
        '#user-name a, #user-name, #user-avatar, [data-user-profile-id], a[href*="space.bilibili.com/"]'
      );
      for (const node of anchors) {
        const attrUid = node.getAttribute && node.getAttribute('data-user-profile-id');
        if (attrUid && /^\d+$/.test(attrUid) && !uid) {
          uid = attrUid;
        }
        const href = (node.getAttribute && node.getAttribute('href')) || '';
        const m = href.match(/space\.bilibili\.com\/(\d+)/);
        if (m && m[1] && !uid) {
          uid = m[1];
        }
        const txt = (node.textContent || '').replace(/^\s+|\s+$/g, '');
        if (txt && !uname && txt.length <= 40 && !txt.startsWith('@')) {
          uname = txt;
        }
      }
    };

    const walkShadow = (root, depth, insideRichText) => {
      if (!root || depth > 5) return;

      if (insideRichText) {
        if (!message) {
          const contentsEl = (root.querySelector && root.querySelector('#contents')) || root;
          message = extractTextWithAlt(contentsEl);
        }
        return;
      }

      // Check <bili-comment-user-info> first for accurate author identity
      const userInfoEl = root.querySelector && root.querySelector('bili-comment-user-info');
      if (userInfoEl && userInfoEl.shadowRoot) {
        ensureObserved(userInfoEl.shadowRoot);
        extractAuthorFromRoot(userInfoEl.shadowRoot);
      }
      if (!uid || !uname) {
        extractAuthorFromRoot(root);
      }

      // Check <bili-rich-text> for comment body
      const richEl = root.querySelector && root.querySelector('bili-rich-text');
      if (richEl && richEl.shadowRoot) {
        ensureObserved(richEl.shadowRoot);
        const contentsEl = richEl.shadowRoot.querySelector('#contents') || richEl.shadowRoot;
        const richMsg = extractTextWithAlt(contentsEl);
        if (richMsg) message = richMsg;
      }

      const children = root.querySelectorAll ? root.querySelectorAll('*') : [];
      for (const child of children) {
        if (
          child.shadowRoot &&
          child.tagName !== 'BILI-COMMENT-REPLIES-RENDERER' &&
          child.tagName !== 'BILI-COMMENT-REPLY-RENDERER'
        ) {
          ensureObserved(child.shadowRoot);
          walkShadow(child.shadowRoot, depth + 1, child.tagName === 'BILI-RICH-TEXT');
        }
      }
    };

    walkShadow(rendererEl.shadowRoot, 0, false);

    if (!uid && !uname && !message) return null;
    return { rpid: '', uid, uname, sign: '', message, ctime: 0, atNames: [] };
  }

  function resolveCommentMeta(rendererEl, threadEl) {
    const rawFromRenderer =
      extractLitCommentPayload(rendererEl) ||
      (threadEl ? extractLitCommentPayload(threadEl) : null);
    if (rawFromRenderer) {
      const indexed = indexRawReplyObject(rawFromRenderer);
      if (indexed) return indexed;
    }

    const domFallback = extractShadowDomFallback(rendererEl);
    if (!domFallback) return null;

    const snip = normalizeSnippet(domFallback.message);
    if (snip) {
      const byUid = domFallback.uid ? metaByFingerprint.get(`u:${domFallback.uid}|${snip}`) : null;
      if (byUid) return byUid;
      const byName = domFallback.uname ? metaByFingerprint.get(`n:${domFallback.uname}|${snip}`) : null;
      if (byName) return byName;
    }

    // Enrich with user-level profile cache (member.sign / uid / uname) captured from API
    const userProfile =
      (domFallback.uid && userByUid.get(domFallback.uid)) ||
      (domFallback.uname && userByUname.get(domFallback.uname)) ||
      null;
    if (userProfile) {
      if (!domFallback.uid && userProfile.uid) domFallback.uid = userProfile.uid;
      if (!domFallback.uname && userProfile.uname) domFallback.uname = userProfile.uname;
      if (!domFallback.sign && userProfile.sign) domFallback.sign = userProfile.sign;
    }

    return domFallback;
  }

  const COLLAPSE_STYLE_CSS = `
    :host([data-bak-state="hidden"]) {
      display: none !important;
    }
    :host([data-bak-state="collapsed"]) > *:not([data-bak-banner]):not(style) {
      display: none !important;
    }
    .bak-banner {
      display: none;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin: 6px 0;
      padding: 6px 12px;
      border-radius: 6px;
      background: rgba(0, 174, 236, 0.06);
      border: 1px dashed rgba(0, 174, 236, 0.28);
      color: #9499a0;
      font-size: 12px;
      line-height: 1.5;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    }
    :host([data-bak-state="collapsed"]) > .bak-banner,
    :host([data-bak-state="expanded"]) > .bak-banner {
      display: flex !important;
    }
    .bak-banner-info {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .bak-badge {
      flex-shrink: 0;
      padding: 1px 6px;
      border-radius: 4px;
      background: rgba(251, 114, 153, 0.14);
      color: #fb7299;
      font-weight: 600;
      font-size: 11px;
    }
    .bak-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-shrink: 0;
    }
    .bak-btn {
      cursor: pointer;
      border: none;
      background: transparent;
      color: #00aeec;
      font-size: 12px;
      padding: 0 4px;
    }
    .bak-btn:hover {
      text-decoration: underline;
    }
    .bak-btn-whitelist {
      color: #9499a0;
    }
    .bak-btn-whitelist:hover {
      color: #fb7299;
    }
  `;

  function ensureCollapseBanner(hostEl, meta, evalResult) {
    const sr = hostEl.shadowRoot;
    if (!sr || sr.childNodes.length === 0) return;

    let styleEl = sr.querySelector('style[data-bak-style]');
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.setAttribute('data-bak-style', '1');
      styleEl.textContent = COLLAPSE_STYLE_CSS;
      sr.appendChild(styleEl);
    }

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
          if (!currentSettings.whitelistUids.includes(targetUid)) {
            currentSettings.whitelistUids.push(targetUid);
          }
          pageContext.confirmedBotUids.delete(String(targetUid));
          settingsEpoch += 1;
          sendToBridge('ADD_WHITELIST_UID', {
            uid: targetUid,
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
      whiteBtn.style.display = meta && meta.uid ? '' : 'none';
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
      hostEl.setAttribute('data-bak-state', 'hidden');
      hostEl.style.setProperty('display', 'none', 'important');
    } else {
      if (hostEl.style && hostEl.style.display === 'none') {
        hostEl.style.removeProperty('display');
      }
      ensureCollapseBanner(hostEl, meta, evalResult);
      if (hostEl.getAttribute('data-bak-state') !== 'expanded') {
        hostEl.setAttribute('data-bak-state', 'collapsed');
      }
    }

    const logKey = (meta && meta.rpid) || `${(meta && meta.uid) || (meta && meta.uname) || ''}:${normalizeSnippet(meta && meta.message)}`;
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

    const freshMeta = resolveCommentMeta(entry.rendererEl, entry.isThread ? hostEl : null);
    if (freshMeta) {
      const newIdKey = getMetaIdentityKey(freshMeta);
      if (entry.identityKey && newIdKey && entry.identityKey !== newIdKey) {
        restoreHost(hostEl);
        entry.lastEvalKey = '';
        entry.lastResult = null;
      }
      entry.meta = freshMeta;
      entry.identityKey = newIdKey;
    } else if (entry.meta && entry.meta.rpid && !entry.meta.sign && metaByRpid.has(entry.meta.rpid)) {
      entry.meta = metaByRpid.get(entry.meta.rpid);
    }

    const meta = entry.meta;
    if (!meta || (!meta.message && !meta.uname && !meta.sign)) return;

    if (!currentSettings.enabled) {
      restoreHost(hostEl);
      return;
    }

    let parentThreadIsAi = false;
    if (!entry.isThread && entry.parentThreadEl) {
      const parentEntry = trackedHosts.get(entry.parentThreadEl);
      if (parentEntry && parentEntry.lastResult && parentEntry.lastResult.action === 'block') {
        parentThreadIsAi = true;
      }
    }

    const llmVerdict = meta.rpid ? llmVerdictByRpid.get(meta.rpid) : null;
    const isWhitelisted = Boolean(meta.uid && currentSettings.whitelistUids.includes(String(meta.uid)));
    const isConfirmedBot =
      !isWhitelisted &&
      Boolean(
        (meta.uid && pageContext.confirmedBotUids.has(String(meta.uid))) ||
          (meta.uname && pageContext.confirmedBotUids.has(`n:${meta.uname}`))
      );
    const evalKey = `${meta.rpid}|${meta.uid}|${meta.uname}|${(meta.sign || '').length}|${(meta.message || '').length}|${isConfirmedBot ? 1 : 0}|${parentThreadIsAi ? 1 : 0}|${llmVerdict ? Number(llmVerdict.isAi) : -1}|${settingsEpoch}`;

    if (entry.lastEvalKey === evalKey && entry.lastResult) {
      if (entry.lastResult.action === 'block') {
        applyBlockToHost(hostEl, meta, entry.lastResult);
      } else {
        restoreHost(hostEl);
      }
      return;
    }

    refreshInitialStateContext();

    // If this username was already confirmed as a bot even without UID, mark uid in context
    const effectiveContext = {
      ...pageContext,
      parentThreadIsAi,
    };

    const res = isConfirmedBot
      ? {
          action: 'block',
          score: 95,
          threshold: 55,
          primaryCategory: 'persona_dafeiyu',
          categoryLabel: '同号AI实锤',
          reasons: ['该账号在本页已实锤为AI号'],
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

  let reevalScheduled = false;
  function scheduleReevaluateTracked(forceFullRescan = false) {
    if (reevalScheduled) return;
    reevalScheduled = true;
    queueMicrotask(() => {
      reevalScheduled = false;
      if (forceFullRescan) {
        scanBiliCommentsTree();
      }
      for (const [hostEl, entry] of trackedHosts.entries()) {
        evaluateAndActOnEntry(hostEl, entry);
      }
    });
  }

  function processThreadRenderer(threadEl) {
    if (!threadEl || !threadEl.shadowRoot) return;
    ensureObserved(threadEl.shadowRoot);

    const mainCommentRenderer = threadEl.shadowRoot.querySelector('bili-comment-renderer');
    if (mainCommentRenderer) {
      if (mainCommentRenderer.shadowRoot) {
        ensureObserved(mainCommentRenderer.shadowRoot);
      }
      let entry = trackedHosts.get(threadEl);
      if (!entry) {
        const initialMeta = resolveCommentMeta(mainCommentRenderer, threadEl);
        entry = {
          rendererEl: mainCommentRenderer,
          parentThreadEl: null,
          isThread: true,
          meta: initialMeta,
          identityKey: getMetaIdentityKey(initialMeta),
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
    if (replyEl.shadowRoot) {
      ensureObserved(replyEl.shadowRoot);
    }
    let resolvedParentThread = parentThreadEl;
    if (!resolvedParentThread) {
      const owner = findOwningCommentHost(replyEl.getRootNode && replyEl.getRootNode());
      if (owner && owner.tagName === 'BILI-COMMENT-THREAD-RENDERER') {
        resolvedParentThread = owner;
      }
    }

    let entry = trackedHosts.get(replyEl);
    if (!entry) {
      const initialMeta = resolveCommentMeta(replyEl, null);
      entry = {
        rendererEl: replyEl,
        parentThreadEl: resolvedParentThread,
        isThread: false,
        meta: initialMeta,
        identityKey: getMetaIdentityKey(initialMeta),
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
    if (rootNode.nodeType === Node.ELEMENT_NODE) {
      const tag = rootNode.tagName;
      if (tag === 'BILI-COMMENTS') {
        if (rootNode.shadowRoot) {
          ensureObserved(rootNode.shadowRoot);
          inspectNodeTree(rootNode.shadowRoot);
        }
      } else if (tag === 'BILI-COMMENT-THREAD-RENDERER') {
        processThreadRenderer(rootNode);
      } else if (tag === 'BILI-COMMENT-REPLIES-RENDERER') {
        if (rootNode.shadowRoot) {
          ensureObserved(rootNode.shadowRoot);
          inspectNodeTree(rootNode.shadowRoot);
        }
      } else if (tag === 'BILI-COMMENT-REPLY-RENDERER') {
        processReplyRenderer(rootNode);
      } else if (tag === 'BILI-COMMENT-RENDERER') {
        if (rootNode.shadowRoot) ensureObserved(rootNode.shadowRoot);
        const hostRoot = rootNode.getRootNode && rootNode.getRootNode();
        if (hostRoot && hostRoot.host && hostRoot.host.tagName === 'BILI-COMMENT-THREAD-RENDERER') {
          processThreadRenderer(hostRoot.host);
        }
      } else if (tag === 'BILI-RICH-TEXT' || tag === 'BILI-COMMENT-USER-INFO') {
        if (rootNode.shadowRoot) {
          ensureObserved(rootNode.shadowRoot);
          const owningHost = findOwningCommentHost(rootNode.shadowRoot);
          if (owningHost) {
            if (owningHost.tagName === 'BILI-COMMENT-REPLY-RENDERER') {
              processReplyRenderer(owningHost);
            } else {
              processThreadRenderer(owningHost);
            }
          }
        }
      }
    }

    if (rootNode.querySelectorAll) {
      const candidates = rootNode.querySelectorAll(
        'bili-comments, bili-comment-thread-renderer, bili-comment-renderer, bili-comment-replies-renderer, bili-comment-reply-renderer, bili-rich-text, bili-comment-user-info'
      );
      for (const el of candidates) {
        if (el.shadowRoot) ensureObserved(el.shadowRoot);
        if (el.tagName === 'BILI-COMMENT-THREAD-RENDERER') {
          processThreadRenderer(el);
        } else if (el.tagName === 'BILI-COMMENT-REPLY-RENDERER') {
          processReplyRenderer(el);
        }
      }
    }
  }

  /**
   * Attaches MutationObserver to a shadowRoot ONCE, without blocking subsequent deep rescans.
   */
  function ensureObserved(shadowRoot) {
    if (!shadowRoot || observedRoots.has(shadowRoot)) return;
    observedRoots.add(shadowRoot);

    const obs = new MutationObserver((mutations) => {
      let needsOwnerCheck = false;
      for (const m of mutations) {
        if (m.type === 'characterData') {
          needsOwnerCheck = true;
          continue;
        }
        for (const added of m.addedNodes) {
          if (added.nodeType === Node.ELEMENT_NODE) {
            inspectNodeTree(added);
          } else if (added.nodeType === Node.TEXT_NODE) {
            needsOwnerCheck = true;
          }
        }
      }
      if (needsOwnerCheck) {
        const owner = findOwningCommentHost(shadowRoot);
        if (owner) {
          const entry = trackedHosts.get(owner);
          if (entry) evaluateAndActOnEntry(owner, entry);
        }
      }
    });
    obs.observe(shadowRoot, { childList: true, subtree: true, characterData: true });
  }

  /**
   * Explicitly walks all <bili-comments> -> <bili-comment-thread-renderer> -> <bili-comment-reply-renderer>
   * even if their outer shadowRoot was already added to observedRoots when initially empty.
   */
  function scanBiliCommentsTree() {
    if (!document || !document.querySelectorAll) return;
    const allCommentRoots = document.querySelectorAll('bili-comments');
    for (const bc of allCommentRoots) {
      if (!bc.shadowRoot) continue;
      ensureObserved(bc.shadowRoot);
      const threads = bc.shadowRoot.querySelectorAll('bili-comment-thread-renderer');
      for (const threadEl of threads) {
        processThreadRenderer(threadEl);
      }
    }
  }

  function setupDocumentObserver() {
    const target = document.body || document.documentElement;
    if (!target || observedRoots.has(target)) return;
    observedRoots.add(target);

    const docObs = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const added of m.addedNodes) {
          if (added.nodeType === Node.ELEMENT_NODE) {
            if (
              added.tagName === 'BILI-COMMENTS' ||
              (added.querySelector && added.querySelector('bili-comments'))
            ) {
              inspectNodeTree(added);
            }
          }
        }
      }
    });
    docObs.observe(target, { childList: true, subtree: true });
    scanBiliCommentsTree();
  }

  let scrollTimer = null;
  window.addEventListener(
    'scroll',
    () => {
      if (scrollTimer) return;
      scrollTimer = setTimeout(() => {
        scrollTimer = null;
        scheduleReevaluateTracked(true);
      }, 150);
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
    }
    scheduleReevaluateTracked(true);
  }, 900);

  document.documentElement.addEventListener(EVT_TO_MAIN, (ev) => {
    if (!ev || typeof ev.detail !== 'string') return;
    try {
      const msg = JSON.parse(ev.detail);
      if (!msg || !msg.type) return;

      if (msg.type === 'SYNC_SETTINGS') {
        currentSettings = detector.normalizeSettings(msg.payload);
        settingsEpoch += 1;
        for (const wUid of currentSettings.whitelistUids) {
          pageContext.confirmedBotUids.delete(wUid);
        }
        scheduleReevaluateTracked(true);
      } else if (msg.type === 'LLM_VERDICTS') {
        const verdicts = Array.isArray(msg.payload) ? msg.payload : [];
        for (const v of verdicts) {
          if (v && v.rpid) {
            pendingLlmRpids.delete(String(v.rpid));
            lruSet(llmVerdictByRpid, String(v.rpid), v, 2000);
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
