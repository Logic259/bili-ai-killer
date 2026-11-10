/**
 * Bili-AI-Killer — Fast Lit & Shadow DOM Extractor + Shared Stylesheet Manager (v3.0)
 * Zero querySelectorAll('*'), zero @mention author confusion, Constructable Stylesheet sharing.
 */
(function initDomExtractor(root) {
  'use strict';

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

  let sharedStyleSheet = null;
  function getSharedStyleSheet() {
    if (sharedStyleSheet !== null) return sharedStyleSheet;
    try {
      if (typeof CSSStyleSheet === 'function') {
        const sheet = new CSSStyleSheet();
        if (typeof sheet.replaceSync === 'function') {
          sheet.replaceSync(COLLAPSE_STYLE_CSS);
          sharedStyleSheet = sheet;
          return sharedStyleSheet;
        }
      }
    } catch (_e) {
      // Fallback for non-constructable environments
    }
    sharedStyleSheet = false;
    return false;
  }

  function injectCollapseStyles(shadowRoot, doc) {
    if (!shadowRoot) return;
    const sheet = getSharedStyleSheet();
    if (sheet && Array.isArray(shadowRoot.adoptedStyleSheets)) {
      if (!shadowRoot.adoptedStyleSheets.includes(sheet)) {
        shadowRoot.adoptedStyleSheets = [...shadowRoot.adoptedStyleSheets, sheet];
      }
      return;
    }
    if (!shadowRoot.querySelector('style[data-bak-style]')) {
      const styleEl = doc.createElement('style');
      styleEl.setAttribute('data-bak-style', '1');
      styleEl.textContent = COLLAPSE_STYLE_CSS;
      shadowRoot.appendChild(styleEl);
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
      if (node.nodeType === 3) {
        out += node.nodeValue || '';
      } else if (node.nodeType === 1) {
        const tag = node.tagName;
        if (tag === 'IMG') {
          const alt = node.getAttribute('alt') || '';
          if (alt) out += alt;
        } else if (tag === 'BR') {
          out += '\n';
        } else if (node.childNodes) {
          for (const ch of node.childNodes) walk(ch);
        }
      }
    };
    walk(container);
    return out.trim();
  }

  function extractShadowDomFallback(rendererEl) {
    if (!rendererEl || !rendererEl.shadowRoot) return null;
    let uid = '';
    let uname = '';
    let level = 0;
    let message = '';
    let contentNode = null;

    const extractAuthorFromRoot = (sr) => {
      if (!sr || !sr.querySelectorAll) return;
      const anchors = sr.querySelectorAll(
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

      if (!level && sr.querySelector) {
        const lvImg = sr.querySelector('img[src*="level_"]');
        if (lvImg) {
          const src = lvImg.getAttribute('src') || '';
          const lm = src.match(/level_(\d)/);
          if (lm) level = Number(lm[1]) || 0;
        }
      }
    };

    const inspectRendererRoot = (sr) => {
      if (!sr || !sr.querySelector) return;

      const userInfoEl = sr.querySelector('bili-comment-user-info');
      if (userInfoEl && userInfoEl.shadowRoot) {
        extractAuthorFromRoot(userInfoEl.shadowRoot);
      }
      if (!uid || !uname) {
        extractAuthorFromRoot(sr);
      }

      const richEl = sr.querySelector('bili-rich-text');
      if (richEl && richEl.shadowRoot) {
        const contentsEl = richEl.shadowRoot.querySelector('#contents') || richEl.shadowRoot;
        const richMsg = extractTextWithAlt(contentsEl);
        if (richMsg) {
          message = richMsg;
          contentNode = contentsEl;
        }
      }
      if (!message) {
        const directContent = sr.querySelector('#contents, #content-text, .reply-content');
        if (directContent) {
          const directMsg = extractTextWithAlt(directContent);
          if (directMsg) {
            message = directMsg;
            contentNode = directContent;
          }
        }
      }

      if (!message || (!uid && !uname)) {
        const nestedRenderer = sr.querySelector('bili-comment-renderer');
        if (nestedRenderer && nestedRenderer.shadowRoot) {
          inspectRendererRoot(nestedRenderer.shadowRoot);
        }
      }
    };

    inspectRendererRoot(rendererEl.shadowRoot);

    if (!uid && !uname && !message) return null;
    const res = { rpid: '', rootId: '', parentId: '', uid, uname, sign: '', level, message, ctime: 0, atNames: [] };
    if (contentNode) {
      Object.defineProperty(res, '__contentNode', { value: contentNode, enumerable: false });
    }
    return res;
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
    root.__BAK_CORE__.domExtractor = {
      injectCollapseStyles,
      extractLitCommentPayload,
      extractShadowDomFallback,
    };
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
