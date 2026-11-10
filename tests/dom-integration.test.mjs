import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extDir = path.resolve(__dirname, '../extension');

function createMockBrowserEnv(mockApiPayload) {
  const NodeConstants = { ELEMENT_NODE: 1, TEXT_NODE: 3 };

  class MockStyle {
    constructor() {
      this._props = new Map();
    }
    setProperty(k, v) {
      this._props.set(k, v);
    }
    removeProperty(k) {
      this._props.delete(k);
    }
    get display() {
      return this._props.get('display') || '';
    }
    set display(v) {
      if (!v) this._props.delete('display');
      else this._props.set('display', v);
    }
  }

  class MockEventTarget {
    constructor() {
      this._listeners = new Map();
    }
    addEventListener(type, fn) {
      if (!this._listeners.has(type)) this._listeners.set(type, new Set());
      this._listeners.get(type).add(fn);
    }
    dispatchEvent(ev) {
      const set = this._listeners.get(ev.type);
      if (set) {
        for (const fn of set) fn.call(this, ev);
      }
      return true;
    }
  }

  class MockNode extends MockEventTarget {
    constructor(nodeType) {
      super();
      this.nodeType = nodeType;
      this.childNodes = [];
      this.parentNode = null;
      this.isConnected = true;
    }
    appendChild(child) {
      child.parentNode = this;
      this.childNodes.push(child);
      notifyMutation(this, [child]);
      return child;
    }
    getRootNode() {
      let cur = this;
      while (cur.parentNode) cur = cur.parentNode;
      return cur;
    }
  }

  const observers = [];
  function notifyMutation(target, addedNodes, type = 'childList') {
    let root = target;
    while (root.parentNode) root = root.parentNode;
    for (const obs of observers) {
      if (obs.targets.has(target) || obs.targets.has(root)) {
        queueMicrotask(() => {
          obs.callback([{ type, addedNodes }]);
        });
      }
    }
  }

  class MockShadowRoot extends MockNode {
    constructor(host) {
      super(11);
      this.host = host;
    }
    querySelector(sel) {
      return this.querySelectorAll(sel)[0] || null;
    }
    querySelectorAll(sel) {
      return matchElements(this, sel);
    }
  }

  class MockElement extends MockNode {
    constructor(tagName) {
      super(NodeConstants.ELEMENT_NODE);
      this.tagName = String(tagName).toUpperCase();
      this.style = new MockStyle();
      this._attrs = new Map();
      this.shadowRoot = null;
      this.className = '';
      this._textContent = '';
    }
    attachShadow() {
      const sr = new MockShadowRoot(this);
      this.shadowRoot = sr;
      return sr;
    }
    setAttribute(k, v) {
      this._attrs.set(k, String(v));
    }
    getAttribute(k) {
      return this._attrs.has(k) ? this._attrs.get(k) : null;
    }
    hasAttribute(k) {
      return this._attrs.has(k);
    }
    removeAttribute(k) {
      this._attrs.delete(k);
    }
    get textContent() {
      if (this.childNodes.length === 0) return this._textContent;
      return this.childNodes.map((c) => c.textContent || c.nodeValue || '').join('');
    }
    set textContent(v) {
      this._textContent = String(v);
      this.childNodes = [];
    }
    set innerHTML(_html) {
      this.childNodes = [];
      const info = new MockElement('div');
      info.className = 'bak-banner-info';
      const badge = new MockElement('span');
      badge.className = 'bak-badge';
      const reason = new MockElement('span');
      reason.className = 'bak-reason-text';
      info.appendChild(badge);
      info.appendChild(reason);

      const actions = new MockElement('div');
      actions.className = 'bak-actions';
      const toggleBtn = new MockElement('button');
      toggleBtn.className = 'bak-btn bak-btn-toggle';
      const whiteBtn = new MockElement('button');
      whiteBtn.className = 'bak-btn bak-btn-whitelist';
      actions.appendChild(toggleBtn);
      actions.appendChild(whiteBtn);

      this.appendChild(info);
      this.appendChild(actions);
    }
    querySelector(sel) {
      return this.querySelectorAll(sel)[0] || null;
    }
    querySelectorAll(sel) {
      return matchElements(this, sel);
    }
  }

  function matchesSingleSelector(el, rawPart) {
    const part = rawPart.trim();
    if (!part) return false;
    if (part === '*') return true;
    if (part.startsWith('#')) {
      const idVal = part.slice(1).split(/\s+/)[0];
      return el.getAttribute('id') === idVal;
    }
    if (part.startsWith('.')) {
      const cls = part.slice(1);
      return (el.className || '').split(/\s+/).includes(cls);
    }
    if (part.includes('[')) {
      const [tagPart, attrExpr] = part.split('[');
      const attrName = attrExpr.replace(/\]$/, '').split(/[*^$~|]?=/)[0];
      if (tagPart && el.tagName !== tagPart.toUpperCase()) return false;
      return el.hasAttribute(attrName);
    }
    return el.tagName === part.toUpperCase();
  }

  function matchElements(root, selectorList) {
    const parts = selectorList.split(',').map((s) => s.trim());
    const results = [];
    const walk = (node) => {
      for (const ch of node.childNodes) {
        if (ch.nodeType === NodeConstants.ELEMENT_NODE) {
          if (parts.some((p) => matchesSingleSelector(ch, p))) {
            results.push(ch);
          }
          walk(ch);
        }
      }
    };
    walk(root);
    return results;
  }

  class MockMutationObserver {
    constructor(cb) {
      this.callback = cb;
      this.targets = new Set();
      observers.push(this);
    }
    observe(target) {
      this.targets.add(target);
    }
    disconnect() {
      this.targets.clear();
    }
  }

  class MockCustomEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.detail = init.detail;
    }
  }

  function MockXHR() {}
  MockXHR.prototype.open = function () {};
  MockXHR.prototype.send = function () {};

  const documentElement = new MockElement('html');
  const document = {
    readyState: 'complete',
    cookie: 'DedeUserID=777777',
    documentElement,
    createElement: (tag) => new MockElement(tag),
    querySelectorAll: (sel) => matchElements(documentElement, sel),
    addEventListener: () => {},
  };

  let currentPayload = mockApiPayload;
  const origAttachShadowRef = MockElement.prototype.attachShadow;
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval: () => 1,
    clearInterval: () => {},
    queueMicrotask,
    Proxy,
    Reflect,
    WeakMap,
    Node: NodeConstants,
    Element: MockElement,
    MutationObserver: MockMutationObserver,
    CustomEvent: MockCustomEvent,
    XMLHttpRequest: MockXHR,
    history: { pushState() {}, replaceState() {} },
    location: { href: 'https://www.bilibili.com/video/BV1test', pathname: '/video/BV1test', search: '' },
    document,
    __INITIAL_STATE__: {
      videoData: { pubdate: 1760000000, owner: { mid: 999999 } },
    },
    setApiPayload: (next) => {
      currentPayload = next;
    },
    fetch: async (_url) => ({
      ok: true,
      clone() {
        return {
          async json() {
            return currentPayload;
          },
        };
      },
      async json() {
        return currentPayload;
      },
    }),
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.addEventListener = () => {};

  vm.createContext(sandbox);
  for (const rel of [
    'core/rules.js',
    'core/detector.js',
    'content/api-sniffer.js',
    'content/dom-extractor.js',
    'content/injected-main.js',
  ]) {
    const code = fs.readFileSync(path.join(extDir, rel), 'utf8');
    vm.runInContext(code, sandbox, { filename: rel });
  }

  // Verify Element.prototype.attachShadow was NEVER hijacked (guarantees Bilibili Lit stability!)
  assert.equal(MockElement.prototype.attachShadow, origAttachShadowRef);

  return { sandbox, document, documentElement, MockElement, MockCustomEvent, notifyMutation };
}

const flushMicrotasks = (ms = 30) => new Promise((r) => setTimeout(r, ms));

test('DOM Integration 1: 被动API嗅探 + Shadow DOM穿透隐藏 + 折叠条实时切换 + 误伤加白恢复', async () => {
  const apiReplyResponse = {
    code: 0,
    data: {
      upper: { mid: 999999 },
      replies: [
        {
          rpid: 101,
          rpid_str: '101',
          mid: 20201,
          ctime: 1760000050,
          member: {
            mid: '20201',
            uname: '深海大肥鱼01',
            sign: '已接入DeepSeek自动巡逻',
          },
          content: {
            message: '本鲸记下了，今天又能多吃两碗白饭！',
          },
          replies: [],
        },
        {
          rpid: 102,
          rpid_str: '102',
          mid: 30301,
          ctime: 1760000600,
          member: {
            mid: '30301',
            uname: '热心老观众',
            sign: '普通游戏玩家',
          },
          content: {
            message: '哈哈哈哈这期视频剪辑节奏太爽了，三连支持一下！',
          },
          replies: [
            {
              rpid: 103,
              rpid_str: '103',
              mid: 40401,
              ctime: 1760000620,
              member: {
                mid: '40401',
                uname: '路人乙',
                sign: 'OpenClaw Agent 自动回复测试',
              },
              content: {
                message: '确实不错。',
              },
            },
          ],
        },
      ],
    },
  };

  const { sandbox, documentElement, MockElement, MockCustomEvent } = createMockBrowserEnv(apiReplyResponse);

  assert.equal(sandbox.__BAK_CORE__, undefined);

  const bridgeMessages = [];
  documentElement.addEventListener('bak:main-to-bridge', (ev) => {
    bridgeMessages.push(JSON.parse(ev.detail));
  });

  await sandbox.fetch('https://api.bilibili.com/x/v2/reply/wbi/main?oid=1&type=1');
  await flushMicrotasks();

  const biliComments = new MockElement('bili-comments');
  const bcShadow = biliComments.attachShadow({ mode: 'open' });

  const aiThread = new MockElement('bili-comment-thread-renderer');
  const aiThreadShadow = aiThread.attachShadow({ mode: 'open' });
  const aiMainRenderer = new MockElement('bili-comment-renderer');
  aiMainRenderer.__data = apiReplyResponse.data.replies[0];
  aiMainRenderer.attachShadow({ mode: 'open' });
  aiThreadShadow.appendChild(aiMainRenderer);

  const humanThread = new MockElement('bili-comment-thread-renderer');
  const humanThreadShadow = humanThread.attachShadow({ mode: 'open' });
  const humanMainRenderer = new MockElement('bili-comment-renderer');
  humanMainRenderer.__data = apiReplyResponse.data.replies[1];
  humanMainRenderer.attachShadow({ mode: 'open' });
  humanThreadShadow.appendChild(humanMainRenderer);

  const repliesHost = new MockElement('bili-comment-replies-renderer');
  const repliesShadow = repliesHost.attachShadow({ mode: 'open' });
  const aiSubReply = new MockElement('bili-comment-reply-renderer');
  aiSubReply.__data = apiReplyResponse.data.replies[1].replies[0];
  aiSubReply.attachShadow({ mode: 'open' });
  repliesShadow.appendChild(aiSubReply);
  humanThreadShadow.appendChild(repliesHost);

  bcShadow.appendChild(aiThread);
  bcShadow.appendChild(humanThread);
  documentElement.appendChild(biliComments);
  await flushMicrotasks();

  assert.equal(aiThread.getAttribute('data-bak-state'), 'hidden');
  assert.equal(aiThread.style.display, 'none');
  assert.equal(humanThread.getAttribute('data-bak-state'), null);
  assert.equal(humanThread.style.display, '');
  assert.equal(aiSubReply.getAttribute('data-bak-state'), 'hidden');
  assert.equal(aiSubReply.style.display, 'none');

  documentElement.dispatchEvent(
    new MockCustomEvent('bak:bridge-to-main', {
      detail: JSON.stringify({
        type: 'SYNC_SETTINGS',
        payload: { enabled: true, displayMode: 'collapse', sensitivity: 'standard' },
      }),
    })
  );
  await flushMicrotasks();

  assert.equal(aiThread.getAttribute('data-bak-state'), 'collapsed');
  const banner = aiThreadShadow.querySelector('.bak-banner');
  assert.ok(banner);

  const whiteBtn = banner.querySelector('.bak-btn-whitelist');
  whiteBtn.dispatchEvent({ type: 'click', stopPropagation() {} });
  await flushMicrotasks();

  assert.equal(aiThread.getAttribute('data-bak-state'), null);
  const whitelistMsg = bridgeMessages.find((m) => m.type === 'ADD_WHITELIST_UID');
  assert.ok(whitelistMsg);
  assert.equal(whitelistMsg.payload.uid, '20201');
});

test('DOM Integration 2: Lit 节点原地复用（切按时间排序/楼中楼翻页）自动恢复与异步 API 精判闭环', async () => {
  const initialPayload = {
    code: 0,
    data: {
      upper: { mid: 999999 },
      replies: [
        {
          rpid: 501,
          rpid_str: '501',
          mid: 601,
          member: { mid: '601', uname: '鲸鱼Bot', sign: '接入DeepSeek' },
          content: { message: '本鲸记下了！' },
        },
        {
          rpid: 502,
          rpid_str: '502',
          mid: 602,
          member: { mid: '602', uname: '灰区伪装者', sign: '' },
          content: { message: '与其说是技术的进步，不如说是时代给我们开的一个小小玩笑。' },
        },
      ],
    },
  };

  const { sandbox, documentElement, MockElement, MockCustomEvent } = createMockBrowserEnv(initialPayload);

  // 开启 API 二次精判配置
  documentElement.dispatchEvent(
    new MockCustomEvent('bak:bridge-to-main', {
      detail: JSON.stringify({
        type: 'SYNC_SETTINGS',
        payload: {
          enabled: true,
          displayMode: 'hide',
          sensitivity: 'standard',
          llm: { enabled: true, apiKey: '__CONFIGURED__', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
        },
      }),
    })
  );

  const bridgeMessages = [];
  documentElement.addEventListener('bak:main-to-bridge', (ev) => {
    bridgeMessages.push(JSON.parse(ev.detail));
  });

  await sandbox.fetch('https://api.bilibili.com/x/v2/reply/wbi/main?oid=1&type=1&mode=3');
  await flushMicrotasks();

  const biliComments = new MockElement('bili-comments');
  const bcShadow = biliComments.attachShadow({ mode: 'open' });

  // 节点 A 初始挂载 AI 评论 (rpid=501) -> 应被隐藏
  const recyclableThread = new MockElement('bili-comment-thread-renderer');
  const threadShadow = recyclableThread.attachShadow({ mode: 'open' });
  const mainRenderer = new MockElement('bili-comment-renderer');
  mainRenderer.__data = initialPayload.data.replies[0];
  mainRenderer.attachShadow({ mode: 'open' });
  threadShadow.appendChild(mainRenderer);

  // 节点 B 初始挂载灰区疑似评论 (rpid=502) -> 先放行并触发 QUEUE_LLM_CHECK
  const grayThread = new MockElement('bili-comment-thread-renderer');
  const grayShadow = grayThread.attachShadow({ mode: 'open' });
  const grayRenderer = new MockElement('bili-comment-renderer');
  grayRenderer.__data = initialPayload.data.replies[1];
  grayRenderer.attachShadow({ mode: 'open' });
  grayShadow.appendChild(grayRenderer);

  bcShadow.appendChild(recyclableThread);
  bcShadow.appendChild(grayThread);
  documentElement.appendChild(biliComments);
  await flushMicrotasks();

  assert.equal(recyclableThread.getAttribute('data-bak-state'), 'hidden');
  assert.equal(grayThread.getAttribute('data-bak-state'), null);

  const llmQueueEvent = bridgeMessages.find((m) => m.type === 'QUEUE_LLM_CHECK');
  assert.ok(llmQueueEvent, 'Expected gray-zone comment to trigger QUEUE_LLM_CHECK');
  assert.equal(llmQueueEvent.payload.rpid, '502');

  // 模拟后台返回 LLM_VERDICTS 判定 rpid=502 为 AI -> 节点 B 应立即无刷新隐藏
  documentElement.dispatchEvent(
    new MockCustomEvent('bak:bridge-to-main', {
      detail: JSON.stringify({
        type: 'LLM_VERDICTS',
        payload: [{ rpid: '502', isAi: true, confirmUid: false, reason: 'AI升华句式' }],
      }),
    })
  );
  await flushMicrotasks();
  assert.equal(grayThread.getAttribute('data-bak-state'), 'hidden');

  // 模拟用户点击“按时间排序”：Lit 原地复用 recyclableThread 节点给一条新的人类评论 (rpid=599)
  const sortedByTimePayload = {
    code: 0,
    data: {
      upper: { mid: 999999 },
      replies: [
        {
          rpid: 599,
          rpid_str: '599',
          mid: 699,
          member: { mid: '699', uname: '刚来的真人观众', sign: '' },
          content: { message: '刚刷到，前排支持一下UP主哈哈哈！' },
        },
      ],
    },
  };
  sandbox.setApiPayload(sortedByTimePayload);
  mainRenderer.__data = sortedByTimePayload.data.replies[0];
  await sandbox.fetch('https://api.bilibili.com/x/v2/reply/wbi/main?oid=1&type=1&mode=2');
  await flushMicrotasks(110);

  // 原先被隐藏的复用节点必须自动恢复显示！
  assert.equal(recyclableThread.getAttribute('data-bak-state'), null);
  assert.equal(recyclableThread.style.display, '');
});

test('DOM Integration 3: 无 __data 属性时纯靠 Shadow DOM (bili-comment-user-info + bili-rich-text) 延迟渲染提取，且不把正文 @别人 误认为作者', async () => {
  const { documentElement, MockElement } = createMockBrowserEnv({ code: 0, data: {} });

  // 先挂载空的 bili-comments（模拟真实B站先挂载容器、后异步渲染内部楼层）
  const biliComments = new MockElement('bili-comments');
  const bcShadow = biliComments.attachShadow({ mode: 'open' });
  documentElement.appendChild(biliComments);
  await flushMicrotasks();

  // 稍后异步插入一条无 __data 属性的主楼（阿斯弗的哦鲸鲸）及楼中楼回复
  const threadEl = new MockElement('bili-comment-thread-renderer');
  const threadShadow = threadEl.attachShadow({ mode: 'open' });
  const mainRenderer = new MockElement('bili-comment-renderer');
  const mainRenderShadow = mainRenderer.attachShadow({ mode: 'open' });

  const userInfo = new MockElement('bili-comment-user-info');
  const userInfoShadow = userInfo.attachShadow({ mode: 'open' });
  const userNameLink = new MockElement('a');
  userNameLink.setAttribute('href', '//space.bilibili.com/70001');
  userNameLink.textContent = '阿斯弗的哦鲸鲸';
  userInfoShadow.appendChild(userNameLink);

  const richText = new MockElement('bili-rich-text');
  const richShadow = richText.attachShadow({ mode: 'open' });
  const contentsP = new MockElement('p');
  contentsP.setAttribute('id', 'contents');
  // 正文里包含指向别人的 @链接，测试不会误把 @不唱歌吉他 当成评论作者
  const atMentionLink = new MockElement('a');
  atMentionLink.setAttribute('href', '//space.bilibili.com/70099');
  atMentionLink.textContent = '@不唱歌吉他';
  const textSpan = { nodeType: 3, nodeValue: ' 我主人要是看见这种教程 估计也得给我升级 先假装没看见喵' };
  contentsP.appendChild(atMentionLink);
  contentsP.childNodes.push(textSpan);
  richShadow.appendChild(contentsP);

  mainRenderShadow.appendChild(userInfo);
  mainRenderShadow.appendChild(richText);
  threadShadow.appendChild(mainRenderer);
  bcShadow.appendChild(threadEl);

  await flushMicrotasks();

  assert.equal(threadEl.getAttribute('data-bak-state'), 'hidden');
  assert.equal(threadEl.style.display, 'none');
});


test('DOM Integration 4: 跨标签页实锤Bot记忆同步 (SYNC_CONFIRMED_BOTS) 与无UID纯 @昵称 一键加白恢复', async () => {
  const { documentElement, MockElement, MockCustomEvent } = createMockBrowserEnv({ code: 0, data: {} });

  // 切换为 collapse 模式以便测试无 UID 节点的折叠横幅加白按钮
  documentElement.dispatchEvent(
    new MockCustomEvent('bak:bridge-to-main', {
      detail: JSON.stringify({
        type: 'SYNC_SETTINGS',
        payload: { enabled: true, displayMode: 'collapse', sensitivity: 'standard' },
        confirmedBots: ['888001'],
      }),
    })
  );

  const biliComments = new MockElement('bili-comments');
  const bcShadow = biliComments.attachShadow({ mode: 'open' });

  // 1. 在其他标签页已被实锤的 UID=888001 在本页哪怕只发“来了”两个字也立即被拦截
  const crossTabBotThread = new MockElement('bili-comment-thread-renderer');
  const crossTabShadow = crossTabBotThread.attachShadow({ mode: 'open' });
  const crossTabRenderer = new MockElement('bili-comment-renderer');
  crossTabRenderer.__data = {
    rpid: 701,
    rpid_str: '701',
    mid: 888001,
    member: { mid: '888001', uname: '潜伏挂机号', sign: '' },
    content: { message: '来了来了' },
  };
  crossTabRenderer.attachShadow({ mode: 'open' });
  crossTabShadow.appendChild(crossTabRenderer);

  // 2. 无 UID 的纯 Shadow DOM 节点命中拦截后，点击“误伤加白”可通过 @昵称 立即恢复
  const noUidThread = new MockElement('bili-comment-thread-renderer');
  const noUidShadow = noUidThread.attachShadow({ mode: 'open' });
  const noUidRenderer = new MockElement('bili-comment-renderer');
  const noUidRenderShadow = noUidRenderer.attachShadow({ mode: 'open' });
  const userSpan = new MockElement('span');
  userSpan.setAttribute('id', 'user-name');
  userSpan.textContent = '无UID测试鱼';
  const richEl = new MockElement('bili-rich-text');
  const richSr = richEl.attachShadow({ mode: 'open' });
  const p = new MockElement('p');
  p.setAttribute('id', 'contents');
  p.childNodes.push({ nodeType: 3, nodeValue: '本鲸今天先摸鱼巡逻中' });
  richSr.appendChild(p);
  noUidRenderShadow.appendChild(userSpan);
  noUidRenderShadow.appendChild(richEl);
  noUidShadow.appendChild(noUidRenderer);

  bcShadow.appendChild(crossTabBotThread);
  bcShadow.appendChild(noUidThread);
  documentElement.appendChild(biliComments);

  await flushMicrotasks();

  assert.equal(crossTabBotThread.getAttribute('data-bak-state'), 'collapsed');
  assert.equal(noUidThread.getAttribute('data-bak-state'), 'collapsed');

  const whiteBtn = noUidShadow.querySelector('.bak-btn-whitelist');
  assert.ok(whiteBtn, 'Expected whitelist button even when numeric UID is absent');
  assert.notEqual(whiteBtn.style.display, 'none');

  whiteBtn.dispatchEvent({ type: 'click', stopPropagation() {} });
  await flushMicrotasks();

  assert.equal(noUidThread.getAttribute('data-bak-state'), null);
});
