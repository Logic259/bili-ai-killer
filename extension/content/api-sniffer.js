/**
 * Bili-AI-Killer — Non-Intrusive API Sniffer & Thread Dynamics Indexer (v3.0)
 * Passively indexes Bilibili's own /x/v2/reply/*, /nav, and /view JSON payloads
 * via native-signature ES6 Proxies (zero extra network requests, zero -352 risk).
 */
(function initApiSniffer(root) {
  'use strict';

  const MAX_META_CACHE = 4500;
  const MAX_USER_CACHE = 3000;
  const MAX_THREAD_CACHE = 800;

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

  function createApiIndexer(pageContext, onReplyBatchIndexed) {
    const metaByRpid = new Map();
    const metaByFingerprint = new Map();
    const userByUid = new Map();
    const userByUname = new Map();
    const threadDynamicsByRoot = new Map();
    let apiEpoch = 1;

    function recordThreadReply(rootId, rpid, ctime, message) {
      if (!rootId || !message) return;
      let dyn = threadDynamicsByRoot.get(rootId);
      if (!dyn) {
        dyn = { rpids: new Set(), entries: [], hasBotCadence: false };
        lruSet(threadDynamicsByRoot, rootId, dyn, MAX_THREAD_CACHE);
      }
      if (rpid && dyn.rpids.has(rpid)) return;
      if (rpid) dyn.rpids.add(rpid);

      if (dyn.entries.length < 24) {
        dyn.entries.push({ ctime: Number(ctime) || 0, message });
      }

      // Check if 3+ longish replies (>=22 chars) occur at suspiciously regular 20s-160s intervals
      if (!dyn.hasBotCadence && dyn.entries.length >= 3) {
        const valid = dyn.entries
          .filter((e) => e.ctime > 0 && e.message.length >= 22)
          .sort((a, b) => a.ctime - b.ctime);
        let fastChain = 0;
        for (let i = 1; i < valid.length; i++) {
          const dt = valid[i].ctime - valid[i - 1].ctime;
          if (dt >= 15 && dt <= 165) {
            fastChain += 1;
            if (fastChain >= 2) {
              dyn.hasBotCadence = true;
              break;
            }
          }
        }
      }
    }

    function indexRawReplyObject(raw) {
      if (!raw || typeof raw !== 'object') return null;
      const rpid = String(raw.rpid_str || raw.rpid || '').trim();
      const rootId = String(raw.root_str || raw.root || '').trim();
      const parentId = String(raw.parent_str || raw.parent || '').trim();
      const member = raw.member || {};
      const content = raw.content || {};

      const uid = String(member.mid || raw.mid_str || raw.mid || '').trim();
      const uname = String(member.uname || '').trim();
      const sign = String(member.sign || '').trim();
      const level = Number((member.level_info && member.level_info.current_level) || member.current_level) || 0;
      const message = String(content.message || '').trim();
      const ctime = Number(raw.ctime) || 0;

      if (uid || uname) {
        const prev = (uid && userByUid.get(uid)) || (uname && userByUname.get(uname)) || null;
        const profileEntry = {
          uid: uid || (prev && prev.uid) || '',
          uname: uname || (prev && prev.uname) || '',
          sign: sign || (prev && prev.sign) || '',
          level: level || (prev && prev.level) || 0,
        };
        if (profileEntry.uid) lruSet(userByUid, profileEntry.uid, profileEntry, MAX_USER_CACHE);
        if (profileEntry.uname) lruSet(userByUname, profileEntry.uname, profileEntry, MAX_USER_CACHE);
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
        rootId: rootId && rootId !== '0' ? rootId : (existing && existing.rootId) || '',
        parentId: parentId && parentId !== '0' ? parentId : (existing && existing.parentId) || '',
        uid: uid || (existing && existing.uid) || '',
        uname: uname || (existing && existing.uname) || '',
        sign: sign || (existing && existing.sign) || '',
        level: level || (existing && existing.level) || 0,
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

      if (merged.rootId) {
        recordThreadReply(merged.rootId, merged.rpid, merged.ctime, merged.message);
      } else if (merged.rpid) {
        recordThreadReply(merged.rpid, merged.rpid, merged.ctime, merged.message);
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

        apiEpoch += 1;
        if (typeof onReplyBatchIndexed === 'function') {
          onReplyBatchIndexed(apiEpoch);
        }
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

    function installNetworkProxies(win) {
      if (!win || typeof Proxy !== 'function') return;

      if (typeof win.fetch === 'function') {
        try {
          win.fetch = new Proxy(win.fetch, {
            apply(target, thisArg, args) {
              let url = '';
              try {
                const input = args[0];
                url = typeof input === 'string' ? input : (input && (input.url || input.href)) || '';
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

      const XHR = win.XMLHttpRequest;
      if (typeof XHR === 'function' && XHR.prototype) {
        try {
          const urlMap = new WeakMap();
          XHR.prototype.open = new Proxy(XHR.prototype.open, {
            apply(target, thisArg, args) {
              try {
                const rawUrl = args[1];
                const urlStr =
                  typeof rawUrl === 'string' ? rawUrl : String((rawUrl && rawUrl.href) || rawUrl || '');
                if (shouldInspectUrl(urlStr)) {
                  urlMap.set(thisArg, urlStr);
                }
              } catch (_e) {
                // ignore
              }
              return Reflect.apply(target, thisArg, args);
            },
          });

          XHR.prototype.send = new Proxy(XHR.prototype.send, {
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
    }

    function getParentContext(meta) {
      if (!meta) return { parentMessage: '', threadBotCadence: false };
      let parentMessage = '';
      if (meta.parentId && metaByRpid.has(meta.parentId)) {
        parentMessage = metaByRpid.get(meta.parentId).message || '';
      } else if (meta.rootId && metaByRpid.has(meta.rootId)) {
        parentMessage = metaByRpid.get(meta.rootId).message || '';
      }
      const dyn = meta.rootId ? threadDynamicsByRoot.get(meta.rootId) : null;
      return {
        parentMessage,
        threadBotCadence: Boolean(dyn && dyn.hasBotCadence),
      };
    }

    return {
      metaByRpid,
      metaByFingerprint,
      userByUid,
      userByUname,
      threadDynamicsByRoot,
      getApiEpoch: () => apiEpoch,
      indexRawReplyObject,
      installNetworkProxies,
      getParentContext,
    };
  }

  if (root) {
    if (!Object.prototype.hasOwnProperty.call(root, '__BAK_CORE__')) {
      Object.defineProperty(root, '__BAK_CORE__', {
        value: {},
        writable: true,
        configurable: true,
        enumerable: false,
      });
    }
    root.__BAK_CORE__.sniffer = {
      lruSet,
      normalizeSnippet,
      createApiIndexer,
    };
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
