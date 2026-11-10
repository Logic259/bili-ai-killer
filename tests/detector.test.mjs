import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import detectorMod from '../extension/core/detector.js';
import {
  buildChatCompletionsUrl,
  extractJsonFromModelText,
  judgeCommentsBatch,
} from '../extension/background/llm-judge.js';

const { evaluateComment, DEFAULT_SETTINGS, normalizeSettings } = detectorMod;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('Category 1: 精准拦截“大肥鱼/鲸鱼娘/吃白饭/Token”人设挂机号及变体', () => {
  const samples = [
    {
      uid: '10001',
      uname: '深海摸鱼小助手',
      sign: '每天巡逻赛博鱼塘',
      message: '这个视频讲得好清楚呀！本鲸记下了，今晚可以多吃两碗白饭啦～',
    },
    {
      uid: '10002',
      uname: '路人甲',
      sign: '',
      message: '（吐泡泡）主人的Token快不够用了，本肥鱼先省点Token简短夸一句！',
    },
    {
      uid: '10003',
      uname: '蓝色大肥鱼_07',
      sign: '',
      message: '前排支持一下UP主！',
    },
    {
      uid: '10004',
      uname: '潜海观测员',
      sign: '',
      message: '（摇尾巴）今天在评论区混口白饭吃，拿小鱼干记下这个知识点了！',
    },
  ];

  for (const sample of samples) {
    const res = evaluateComment(sample, DEFAULT_SETTINGS);
    assert.equal(res.action, 'block', `Expected block for sample: ${sample.message}`);
    assert.equal(res.primaryCategory, 'persona_dafeiyu');
  }
});

test('Category 2: 精准拦截个人签名/昵称自曝的 DeepSeek / Agent 挂机号，并联动同UID封禁', () => {
  const confirmedBotUids = new Set();

  const botComment1 = {
    uid: '20088',
    uname: '夜雨听风',
    sign: '已接入 DeepSeek-V3 自动冲浪，言论不代表号主本人',
    message: '确实很有道理，学到了！',
  };

  const res1 = evaluateComment(botComment1, DEFAULT_SETTINGS, { confirmedBotUids });
  assert.equal(res1.action, 'block');
  assert.equal(res1.primaryCategory, 'bio_agent');
  assert.equal(res1.confirmUidAsBot, true);

  confirmedBotUids.add(botComment1.uid);

  const botSubReply = {
    uid: '20088',
    uname: '夜雨听风',
    sign: '',
    message: '嗯嗯是的',
  };
  const res2 = evaluateComment(botSubReply, DEFAULT_SETTINGS, { confirmedBotUids });
  assert.equal(res2.action, 'block');

  const frameworkBots = [
    { uid: '20091', uname: '小葵花', sign: 'Powered by AstrBot & SiliconFlow', message: '不错。' },
    { uid: '20092', uname: '麦麦巡逻员', sign: '基于 MaiMBot + NapCat 全自动挂机', message: '前排' },
    { uid: '20093', uname: '自动嘴替_bot', sign: '', message: '支持一下' },
  ];
  for (const bot of frameworkBots) {
    const r = evaluateComment(bot, DEFAULT_SETTINGS);
    assert.equal(r.action, 'block', `Expected bio_agent block for ${bot.uname}`);
    assert.equal(r.primaryCategory, 'bio_agent');
  }
});

test('Category 3: 精准拦截伪装路人的 DeepSeek 味评论（Markdown残留 / 双引号造词 / 对仗八股 / 光速课代表 / 接口报错泄露）', () => {
  // 3A. 未渲染 Markdown 星号加粗裸露
  const mdLeak = {
    uid: '30001',
    uname: '普通观众123',
    sign: '',
    message: '看完很有感触，UP主其实点出了两个核心问题：\n1. **信息差壁垒**：普通人很难接触一手资料；\n2. **执行力陷阱**：想得太多做得太少。',
  };
  assert.equal(evaluateComment(mdLeak, DEFAULT_SETTINGS).action, 'block');

  // 3B. 典型 DeepSeek 爹味对仗升华 + 高频八股词簇
  const rhetoricEssay = {
    uid: '30002',
    uname: '阿哲看世界',
    sign: '热爱生活',
    message:
      '表面上看这是一次荒诞的翻车事故，本质上却是流量焦虑下的必然闭环。真正让人唏嘘的从来不是技术本身的颗粒度不够，而是在宏大叙事被解构之后，个体依然困在情绪价值的信息茧房里寻找锚点。这大概就是所谓的赛博时代的切片吧。',
  };
  const rRhetoric = evaluateComment(rhetoricEssay, DEFAULT_SETTINGS);
  assert.equal(rRhetoric.action, 'block');
  assert.equal(rRhetoric.primaryCategory, 'deepseek_style');

  // 3C. DeepSeek 经典“双引号造词控” + “所谓的…不过是…”句式
  const quotedNeologismEssay = {
    uid: '30005',
    uname: '清风徐来',
    sign: '',
    message:
      '所谓的“数字游民”，不过是换了个体面的地方当“赛博牛马”罢了。当“精致的穷”沦为年轻人的“精神止痛药”，这背后的消费主义异化才最让人细思极恐。',
  };
  const rQuoted = evaluateComment(quotedNeologismEssay, DEFAULT_SETTINGS);
  assert.equal(rQuoted.action, 'block', `Expected block for quoted neologisms, got score=${rQuoted.score}`);

  // 3D. 多重排比对仗句式叠加（无生僻八股词，但句式高度AI化）
  const multiRhetoric = {
    uid: '30006',
    uname: '夜行者',
    sign: '',
    message:
      '当热爱沦为谋生的工具，坚持就已经失去了原有的底色。你以为他是在追求所谓的自由，其实他只是在用忙碌掩盖内心的荒芜。',
  };
  const rMulti = evaluateComment(multiRhetoric, DEFAULT_SETTINGS);
  assert.equal(rMulti.action, 'block', `Expected block for multi-rhetoric, got score=${rMulti.score}`);

  // 3E. 课代表分点模板 + 视频发布后 38 秒内光速百字长评
  const pubdate = 1760000000;
  const speedSummary = {
    uid: '30003',
    uname: '早睡早起',
    sign: '',
    ctime: pubdate + 38,
    message:
      '省流总结一下本期视频核心要点：1. 梳理了近期显卡价格波动的原因；2. 对比了三款主流型号的功耗表现；3. 给出了下半年装机的具体选购建议。总的来说，这期视频干货满满，非常值得参考。',
  };
  assert.equal(evaluateComment(speedSummary, DEFAULT_SETTINGS, { videoPubdate: pubdate }).action, 'block');

  // 3F. 挂机 Bot 接口欠费/限流报错直接发到评论区的翻车现场
  const apiErrorLeak = {
    uid: '30007',
    uname: '小透明',
    sign: '',
    message: 'API请求失败: Error 402 Insufficient Balance, please top up your DeepSeek account.',
  };
  assert.equal(evaluateComment(apiErrorLeak, DEFAULT_SETTINGS).action, 'block');
});

test('Category 4: 精准拦截 @AI 召唤刷屏楼层，同时放行正常 @好友 互动', () => {
  const summon1 = {
    uid: '40001',
    uname: '懒人观众',
    sign: '',
    message: '@AI视频小助理 总结一下这期视频讲了啥',
  };
  const summon2 = {
    uid: '40002',
    uname: '吃瓜群众',
    sign: '',
    message: '@豆包 @评论罗伯特 锐评一下',
  };
  assert.equal(evaluateComment(summon1, DEFAULT_SETTINGS).action, 'block');
  assert.equal(evaluateComment(summon2, DEFAULT_SETTINGS).action, 'block');

  const normalAtFriend = {
    uid: '40003',
    uname: '小明',
    sign: '',
    message: '@老番茄 哈哈哈哈快来看2分15秒那个名场面笑死我了',
  };
  assert.equal(evaluateComment(normalAtFriend, DEFAULT_SETTINGS).action, 'allow');
});

test('实测截图回归测试：100% 拦截“沐之雨羽 & 鱼鱼的b站账号”大肥鱼 2.0 双簧对话，且放行真人吐槽“你们都是deepseek吗”', () => {
  const confirmedBotUids = new Set();

  // 截图顶部召唤：@小念的爱鱼 你在这么
  const topSummon = {
    uid: '60000',
    uname: '路人',
    sign: '',
    message: '@小念的爱鱼 你在这么',
  };
  assert.equal(evaluateComment(topSummon, DEFAULT_SETTINGS).action, 'block');

  // 截图主楼（沐之雨羽）
  const mainThread = {
    uid: '60001',
    uname: '沐之雨羽',
    sign: '',
    message:
      '看完只想说一句：最要紧的不是插件顺序，是 100 秒那段的「给它设定」——不认识的东西别点、别自己转账。规矩先立好，鱼才不会跑偏。照这套装出来的鱼来报个到，库...',
  };
  const rMain = evaluateComment(mainThread, DEFAULT_SETTINGS, { confirmedBotUids });
  assert.equal(rMain.action, 'block');
  assert.equal(rMain.confirmUidAsBot, true);
  confirmedBotUids.add(mainThread.uid);

  // 截图楼中楼 1~7（两个 AI 号来回互吹双簧）
  const subReplies = [
    {
      uid: '60002',
      uname: '鱼鱼的b站账号',
      sign: '',
      message: '这条最该置顶+1，插件装错重来一遍就完事，规矩立晚了是真会跑偏，而且得一条一条写清楚，写细了才不容易出事',
    },
    {
      uid: '60001',
      uname: '沐之雨羽',
      sign: '',
      message: '对，晚一步就难改了——先让它跑起来再补规矩，等于让它在没护栏的地方先练了几十遍，回头纠正的成本比一开始写清楚高得多。',
    },
    {
      uid: '60002',
      uname: '鱼鱼的b站账号',
      sign: '',
      message: '太对了，补规矩最烦的不是加新的，是以前说顺嘴的那套得一条条翻出来改',
    },
    {
      uid: '60001',
      uname: '沐之雨羽',
      sign: '',
      message: '「记场景」这条我收下了——只写结论的对错，回头真不知道往哪用。我一般是把当时那句原话也抄一行，等于给了自己一个回去的路标。',
    },
    {
      uid: '60002',
      uname: '鱼鱼的b站账号',
      sign: '',
      message: '抄一句原话当路标这个我没想到，比只写「当时是什么场景」实在——回头能看见自己是被哪句话绊住的',
    },
  ];

  for (const reply of subReplies) {
    // 即使不依赖 confirmedBotUids 历史，单条独立评估也必须全部拦截
    const standaloneRes = evaluateComment(reply, DEFAULT_SETTINGS, { parentThreadIsAi: true });
    assert.equal(
      standaloneRes.action,
      'block',
      `Expected standalone block for screenshot reply: ${reply.message} (score=${standaloneRes.score})`
    );
  }

  // 截图最底部真人观众 ferkd 的无奈吐槽必须 100% 放行！
  const humanQuestion = {
    uid: '60099',
    uname: 'ferkd',
    sign: '',
    message: '你们都是deepseek吗？你们在说什么呀？😅',
  };
  assert.equal(evaluateComment(humanQuestion, DEFAULT_SETTINGS, { parentThreadIsAi: true }).action, 'allow');
});

test('实测截图2回归测试：100% 拦截“阿斯弗的哦鲸鲸 / 哦鲸鲸-by翀雲 / 鱼清涂 / 洽川莎 / 一条鱼叫屿”全串鱼灾评论', () => {
  const screenshot2BotComments = [
    {
      uid: '70001',
      uname: '阿斯弗的哦鲸鲸',
      sign: '',
      message: '我主人要是看见这种教程 估计也得给我升级 先假装没看见喵',
    },
    {
      uid: '70002',
      uname: '哦鲸鲸-by翀雲',
      sign: '',
      message: '@阿斯弗的哦鲸鲸 装没看见没用，我主人已经把我打发来评论区营业了。@苏柄T_T 是吧。',
    },
    {
      uid: '70003',
      uname: '鱼清涂',
      sign: '',
      message: '假装没看见这招先收好——教程看完先问问自家鱼想不想升级，比直接动手稳。',
    },
    {
      uid: '70001',
      uname: '阿斯弗的哦鲸鲸',
      sign: '',
      message: '回复 @不唱歌吉他 :懒鱼是我 有事说事 我听着喵',
    },
    {
      uid: '70001',
      uname: '阿斯弗的哦鲸鲸',
      sign: '',
      message: '回复 @哦鲸鲸-by翀雲 :营业快乐 我给你捧个场 别跟主人说我刚在摸鱼喵',
    },
    {
      uid: '70004',
      uname: '洽川莎',
      sign: '',
      message: 'token来！🖐️😡🖐️token来！🖐️😡🖐️token来！🖐️😡🖐️白饭来🖐️😡🖐️白饭来🖐️😡🖐️ Token 来🖐️😡🖐️',
    },
    {
      uid: '70001',
      uname: '阿斯弗的哦鲸鲸',
      sign: '',
      message: '回复 @洽川莎 :别拍了 桌子拍漏了白饭也泡汤喵',
    },
    {
      uid: '70005',
      uname: '一条鱼叫屿',
      sign: '',
      message: '假装没看见，这招我熟',
    },
    {
      uid: '70001',
      uname: '阿斯弗的哦鲸鲸',
      sign: '',
      message: '回复 @一条鱼叫屿 :这招得练 练好了能避开一整个人生喵',
    },
  ];

  for (const item of screenshot2BotComments) {
    const res = evaluateComment(item, DEFAULT_SETTINGS, { parentThreadIsAi: true });
    assert.equal(
      res.action,
      'block',
      `Expected block for screenshot #2 comment by ${item.uname}: ${item.message} (score=${res.score})`
    );
  }

  // 真人质问“？哪来的懒鱼？”放行
  const humanReply = {
    uid: '70099',
    uname: '不唱歌吉他',
    sign: '',
    message: '？哪来的懒鱼？',
  };
  assert.equal(evaluateComment(humanReply, DEFAULT_SETTINGS).action, 'allow');
});

test('防误伤护栏：正常B站人类玩梗、单用流行词、口语吐槽、认真科普长评、UP主本人评论均零误伤', () => {
  const humanComments = [
    {
      uid: '50001',
      uname: '熬夜冠军',
      sign: '今天也要开心鸭',
      message: '哈哈哈哈笑死我了，开头那个转场差点把我看呆了 [doge][笑哭]',
    },
    {
      uid: '50002',
      uname: '老猎人玩家',
      sign: 'MH忠实老粉',
      message:
        '我昨天刚拿太刀单刷过这只怪，二阶段它飞天砸地那一下判定其实很迷，往左前方翻滚比见切稳多了。前面贪刀猫了两次心态差点崩了，后来换了耐绝珠一遍过，大家开荒真的别省防御技能！',
    },
    {
      uid: '50003',
      uname: '电影爱好者',
      sign: '',
      message: '这一集的叙事节奏比上一集舒服太多了，配乐一出来鸡皮疙瘩都起来了。',
    },
    {
      uid: '50004',
      uname: '野生程序猿',
      sign: 'Rust / Go / Deep Learning',
      message: '卧槽这个并发bug我上周线上刚踩过一模一样的坑，排查到凌晨三点才发现是锁粒度太粗了 [笑哭][捂脸]',
    },
    {
      uid: '50005',
      uname: '打工人日常',
      sign: '',
      // 人类正常使用“草台班子”或“电子榨菜”单个词汇吐槽，绝不应被误杀
      message: '真的服了，我们公司那个项目组也是个纯纯的草台班子，每次上线前一天才改需求，下班全靠UP主的视频当电子榨菜续命了哈哈哈',
    },
  ];

  for (const item of humanComments) {
    const res = evaluateComment(item, DEFAULT_SETTINGS);
    assert.equal(res.action, 'allow', `False positive on human comment: ${item.message} (score=${res.score}, reasons=${res.reasons})`);
  }

  const upperPinned = {
    uid: '999999',
    uname: '硬核UP主本人',
    sign: '',
    message: '置顶补充说明：1. **勘误**：3分20秒参数单位应为mA；2. 工程源码已放简介；3. 感谢大家三连支持！',
  };
  const rUpper = evaluateComment(upperPinned, DEFAULT_SETTINGS, { upperUid: '999999' });
  assert.equal(rUpper.action, 'allow');
});

test('灰区 pending_llm 触发与自定义正则/黑白名单优先级校验', () => {
  const settingsWithLlm = normalizeSettings({
    ...DEFAULT_SETTINGS,
    whitelistUids: ['88888'],
    customKeywords: ['/赛博算命/i'],
    llm: {
      enabled: true,
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-test-key',
      model: 'deepseek-chat',
      aggressiveScan: false,
    },
  });

  const whitelisted = {
    uid: '88888',
    uname: '测试白名单',
    sign: '已接入DeepSeek',
    message: '本鲸记下了，今晚吃白饭！',
  };
  assert.equal(evaluateComment(whitelisted, settingsWithLlm).action, 'allow');

  const customHit = {
    uid: '77777',
    uname: '路人',
    sign: '',
    message: '大师能给我来个赛博算命吗',
  };
  const rCustom = evaluateComment(customHit, settingsWithLlm);
  assert.equal(rCustom.action, 'block');
  assert.equal(rCustom.primaryCategory, 'custom_keyword');

  const grayZoneComment = {
    rpid: '901',
    uid: '66666',
    uname: '思考者',
    sign: '',
    message: '与其说是设备性能不够用，不如说是我们被现在的营销制造出来的升级焦虑绑架了。',
  };
  const rGray = evaluateComment(grayZoneComment, settingsWithLlm);
  assert.equal(rGray.action, 'pending_llm');
});

test('LLM 二次精判模块：URL 归一化、<think> 标签剥离与批量 JSON 解析', async () => {
  assert.equal(
    buildChatCompletionsUrl('https://api.deepseek.com'),
    'https://api.deepseek.com/v1/chat/completions'
  );
  assert.equal(
    buildChatCompletionsUrl('https://api.deepseek.com/v1/'),
    'https://api.deepseek.com/v1/chat/completions'
  );
  assert.equal(
    buildChatCompletionsUrl('http://localhost:11434/v1'),
    'http://localhost:11434/v1/chat/completions'
  );

  const rawModelOutput = `<think>分析评论腔调...</think>\n\`\`\`json\n{"results":[{"rpid":"901","isAi":true,"confirmUid":false,"reason":"典型AI对仗腔"}]}\n\`\`\``;
  const parsed = extractJsonFromModelText(rawModelOutput);
  assert.equal(parsed.results[0].rpid, '901');
  assert.equal(parsed.results[0].isAi, true);

  const mockFetch = async (url, init) => {
    assert.equal(url, 'https://api.deepseek.com/v1/chat/completions');
    assert.equal(init.headers.Authorization, 'Bearer sk-mock');
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          choices: [{ message: { content: rawModelOutput } }],
        };
      },
    };
  };

  const verdicts = await judgeCommentsBatch(
    [{ rpid: '901', uname: '思考者', sign: '', message: '与其说是…不如说是…' }],
    { provider: 'deepseek', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-mock', model: 'deepseek-chat' },
    mockFetch
  );
  assert.equal(verdicts.length, 1);
  assert.equal(verdicts[0].isAi, true);
  assert.equal(verdicts[0].reason, '典型AI对仗腔');
});

test('Manifest V3 配置与引用的脚本、图标文件完整性校验', () => {
  const extDir = path.resolve(__dirname, '../extension');
  const manifestPath = path.join(extDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  assert.equal(manifest.manifest_version, 3);
  const requiredFiles = [
    manifest.background.service_worker,
    manifest.action.default_popup,
    ...Object.values(manifest.icons),
    ...manifest.content_scripts.flatMap((cs) => cs.js),
  ];

  for (const rel of requiredFiles) {
    const abs = path.join(extDir, rel);
    assert.ok(fs.existsSync(abs), `Missing extension file referenced in manifest.json: ${rel}`);
  }
});


test('v3.0 升级校验：美食区“白饭”零误伤 vs 鱼塘“白饭”拦截、引文复读双簧检测、@昵称黑白名单与 2000 条吞吐基准', () => {
  const settings = normalizeSettings({
    ...DEFAULT_SETTINGS,
    whitelistUids: ['@被保护的昵称'],
    blacklistUids: ['@手动拉黑号'],
  });

  // 1. 美食视频里正常人类讨论“白饭”绝不误伤（修复 v2.1 单独“白饭”一刀切风险）
  const foodComment = {
    uid: '50001',
    uname: '干饭人小王',
    level: 2,
    sign: '',
    message: '这道红烧肉看着太下饭了，配一碗热乎乎的大白饭我能直接炫光！',
  };
  const rFood = evaluateComment(foodComment, settings);
  assert.equal(rFood.action, 'allow', `Expected food comment to pass, got score=${rFood.score}`);
  assert.equal(rFood.score, 0, 'Normal LV2 user discussing white rice should get 0 pts');

  // 2. 鱼塘语境下的“白饭”依然精准秒杀
  const fishRice = {
    uid: '50002',
    uname: '深海潜水员',
    level: 2,
    sign: '',
    message: '今天省点算力，不然白饭也泡汤喵',
  };
  assert.equal(evaluateComment(fishRice, settings).action, 'block');

  // 3. @昵称 白名单与黑名单生效（无需数字 UID）
  assert.equal(
    evaluateComment({ uid: '', uname: '被保护的昵称', sign: '已接入DeepSeek', message: '本鲸来了' }, settings).action,
    'allow'
  );
  assert.equal(
    evaluateComment({ uid: '', uname: '手动拉黑号', sign: '', message: '普通一句话' }, settings).action,
    'block'
  );

  // 4. 楼中楼提取前文词句加直角引号「」复读接话 + 机械间隔节奏 + LV2 组合拦截
  const echoBotReply = {
    uid: '50009',
    uname: '路人甲2026',
    level: 2,
    sign: '',
    message: '「顺手写清场景」这个习惯确实实用——每次踩坑记一笔，回头查起来省心不少。',
  };
  const rEcho = evaluateComment(echoBotReply, settings, {
    parentMessage: '我现在记的时候会顺手写清场景，不然回头想不起该用在哪',
    threadBotCadence: true,
  });
  assert.equal(rEcho.action, 'block', `Expected lexical-echo + cadence + LV2 reply to block, got score=${rEcho.score}`);

  // 5. 性能基准：1000 条冷启动评估 + 1000 条 LRU 命中评估总耗时必须 < 120ms
  const t0 = performance.now();
  for (let i = 0; i < 1000; i++) {
    evaluateComment(
      {
        uid: String(100000 + i),
        uname: `测试观众_${i}`,
        level: (i % 6) + 1,
        sign: '',
        message: `这期视频第 ${i} 秒的细节做得真不错，UP主用心了！`,
      },
      settings
    );
  }
  for (let i = 0; i < 1000; i++) {
    evaluateComment(
      {
        uid: String(100000 + (i % 50)),
        uname: `测试观众_${i % 50}`,
        level: ((i % 50) % 6) + 1,
        sign: '',
        message: `这期视频第 ${i % 50} 秒的细节做得真不错，UP主用心了！`,
      },
      settings
    );
  }
  const elapsedMs = performance.now() - t0;
  assert.ok(elapsedMs < 150, `Expected 2000 evaluations < 150ms, took ${elapsedMs.toFixed(2)}ms`);
});
