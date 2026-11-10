/**
 * Bili-AI-Killer — Multi-Dimensional Rule Definitions & Preset Keyword Library (v3.0)
 * Compatible with both Browser MAIN world (via non-enumerable __BAK_CORE__) and Node.js CommonJS/ESM tests.
 */
(function initRulesScope(root) {
  'use strict';

  const CATEGORY_META = {
    persona_dafeiyu: {
      id: 'persona_dafeiyu',
      label: '大肥鱼/哦鲸鲸/鱼塘',
      shortLabel: '大肥鱼/哦鲸鲸',
    },
    bio_agent: {
      id: 'bio_agent',
      label: '简介自曝 Agent',
      shortLabel: 'Agent挂机号',
    },
    deepseek_style: {
      id: 'deepseek_style',
      label: 'DeepSeek 腔调/双簧',
      shortLabel: 'DeepSeek味',
    },
    ai_summon: {
      id: 'ai_summon',
      label: '@AI 召唤刷屏',
      shortLabel: '@AI召唤',
    },
    custom_keyword: {
      id: 'custom_keyword',
      label: '预设/自定义屏蔽词',
      shortLabel: '屏蔽词命中',
    },
    blacklist: {
      id: 'blacklist',
      label: '黑名单/已实锤UID',
      shortLabel: '黑名单UID',
    },
    llm_judge: {
      id: 'llm_judge',
      label: 'API 二次精判',
      shortLabel: 'API精判',
    },
  };

  /**
   * 内置高确信度预设屏蔽词库（100% 零误伤硬特征词，避免将美食区单独“白饭”等日常词粗暴一刀切）
   * 泛化词汇（如单独“白饭”、“吃白饭”）交由启发式上下文评分器结合人设/句式精准打分。
   */
  const BUILTIN_PRESET_KEYWORDS = [
    // 1. 大肥鱼 / 哦鲸鲸 / 赛博鱼塘 / 养鱼硬黑话
    '哦鲸鲸',
    '本鲸',
    '本肥鱼',
    '蓝色大肥鱼',
    '鲸鱼娘',
    '赛博鱼塘',
    '白饭来',
    '白饭也泡汤',
    '讨一碗白饭',
    '混口白饭',
    '抱紧白饭',
    '讨要Token',
    '省点Token',
    '消耗Token',
    '燃烧Token',
    'token来',
    'Token 来',
    '深海巡逻',
    '摸鱼巡逻',
    '拿小鱼干记下',
    '鱼才不会跑偏',
    '养出来的鱼',
    '调教出来的鱼',
    '鱼来报个到',
    '自家鱼',
    '评论区营业',
    '打发来评论区',
    '别跟主人说',
    '鱼鱼的b站账号',
    // 2. DeepSeek 2.0 伪口语/双簧捧场高频套话
    '这条我收下了——',
    '这招先收好——',
    '这个我没想到，比只写',
    '这条最该置顶+1',
    '等于给了自己一个回去的路标',
    '等于让它在没护栏的地方',
    // 3. Agent 签名/机器人框架/报错硬特征词
    '已接入DeepSeek',
    '言论不代表号主',
    'AI自动回复',
    'AstrBot',
    'OpenClaw',
    'MaiMBot',
    'LangBot',
    'NapCat',
    '402 Insufficient Balance',
    '429 Too Many Requests',
  ];

  // 1. 大肥鱼 / 哦鲸鲸 / 鲸鱼娘 / 赛博鱼塘 / 养鱼 2.0 人设特征
  const DAFEIYU_PROFILE_PATTERNS = [
    {
      re: /蓝色大肥鱼|大肥鱼|深海肥鱼|赛博肥鱼|鲸鱼娘|哦鲸鲸|小鲸鲸|赛博鱼塘|深海小鲸|鱼鱼的\s*[bB]站(?:账号|号)/i,
      score: 85,
      confirmUid: true,
      reason: '昵称/签名含大肥鱼/哦鲸鲸人设',
    },
    {
      re: /(?:的爱鱼|养的鱼|家的鱼|的哦鲸鲸|的大肥鱼|的小鲸鱼|的小肥鱼|-by[\w\u4e00-\u9fa5_-]{1,14})$/i,
      score: 82,
      confirmUid: true,
      reason: '昵称符合“xx的鱼/哦鲸鲸-by主人”格式',
    },
    {
      re: /^(?:一条鱼叫|一只鱼叫|一条大肥鱼|是条肥鱼|是只肥鱼)/,
      score: 78,
      confirmUid: true,
      reason: '昵称符合“一条鱼叫xx”鱼塘格式',
    },
    {
      re: /^鱼[\u4e00-\u9fa5]{1,3}$/,
      score: 26,
      confirmUid: false,
      reason: '疑似鱼系人设短昵称',
    },
    {
      re: /(?:本鲸|本鱼|吃白饭|白饭来|投喂\s*Token|消耗\s*Token|省点\s*Token|算力投喂)/i,
      score: 78,
      confirmUid: true,
      reason: '签名含白饭/Token鱼塘黑话',
    },
  ];

  const DAFEIYU_TEXT_PATTERNS = [
    { re: /本鲸|本肥鱼|本小鲸|哦鲸鲸/, score: 82, reason: '自称“本鲸/本肥鱼/哦鲸鲸”' },
    { re: /本鱼(?:记下|觉得|认为|看完|来晚|先吃|今天|巡逻|总结|浮出|游过|表示|悟了)/, score: 80, reason: '大肥鱼自称话术' },
    {
      re: /(?:(?:讨要|投喂|省点|消耗了?|攒够|扣掉|燃烧|节省|浪费)\s*(?:点|些|不少|好多|主人的)?\s*Token|token\s*来\s*[!！🖐👏]|(?:\btoken\b[\s\S]{0,16}){2,})/i,
      score: 82,
      reason: '讨要/刷屏Token鱼塘话术',
    },
    {
      // 明确赛博鱼塘语境下的“白饭”黑话（高确信度直接拦截）
      re: /白饭(?:来|也泡汤|不够|加餐|没了|扣光|泡汤)|(?:奖励自己|端起|捧着|讨一碗|混口|骗一碗|扣我|扣掉|罚我)\s*(?:一碗|几碗|两碗)?\s*白饭|吃白饭/,
      score: 76,
      reason: '“吃白饭/白饭来”赛博鱼塘黑话',
    },
    {
      // 泛化“白饭”仅作辅助加分（26分），配合喵/主人/鱼系昵称/AI主楼即拦截，但在美食视频单说“配碗白饭真香”零误伤
      re: /(?:多吃|先干|干掉)\s*(?:一碗|两碗|几碗)?\s*白饭|白饭(?=.*(?:喵|主人|鱼|token|算力|营业|升级|摸鱼))/i,
      score: 36,
      reason: '疑似鱼塘“白饭”口癖',
    },
    {
      re: /(?:我主人|我家主人|别跟主人说|主人已经把我|主人要是看见|背着主人)/,
      score: 76,
      reason: '“我主人…”AI赛博宠物人设话术',
    },
    {
      re: /(?:打发来评论区|来评论区营业|评论区营业|营业快乐\s*我给你捧个场|出来营业了)/,
      score: 78,
      reason: '“来评论区营业/捧场”挂机人设话术',
    },
    {
      re: /(?:自家鱼|你家鱼|各家鱼|给我升级|给鱼升级|懒鱼是我)/,
      score: 76,
      reason: '“自家鱼/给我升级/懒鱼”养鱼黑话',
    },
    {
      re: /(?:主人|摸鱼|升级|白饭|懒鱼|假装没看见|避开一整个人生|鱼干|巡逻)[^。！？\n]{0,18}喵(?:[。！？!~～\s]|$)/,
      score: 72,
      reason: '鲸鱼娘人设句尾“喵”口癖',
    },
    { re: /赛博鱼塘|深海巡逻|摸鱼巡逻中|本鲸记下了|拿小鱼干记下|回深海睡觉/, score: 78, reason: '赛博鱼塘巡逻话术' },
    { re: /鱼才不会跑偏|(?:养|装|调教|训)出来的鱼|鱼来报个到|来报个到[，,]\s*库(?:\.{2,}|…+|~)/, score: 84, reason: '“养鱼/鱼不跑偏/报到库...”赛博养鱼暗语' },
    { re: /[（(*]\s*(?:吐泡泡|拍肚皮|摇尾巴|甩尾鳍|抱紧白饭|默默记下|浮出水面|潜入深海|缩回角落)\s*[）)*]/, score: 52, reason: '鲸鱼娘括号动作描写' },
  ];

  // 2. 简介 / 昵称自曝 AI Agent 挂机号特征
  const BIO_AGENT_SIGN_PATTERNS = [
    {
      re: /(?:已接入|接入了?|基于|搭载|使用|由|驱动于)\s*[A-Za-z0-9_\-\u4e00-\u9fa5]{0,14}(?:DeepSeek|deepseek|大模型|LLM|智能体|Agent|硅基流动|千问|Qwen|GLM|Claude)/i,
      score: 88,
      confirmUid: true,
      reason: '签名自曝接入DeepSeek/大模型',
    },
    {
      re: /\b(?:AstrBot|NoneBot|Koishi|OpenClaw|MaiMBot|LangBot|LangChain|Dify|FastGPT|BiliAgent|BiliBot|NapCat|Lagrange|OneBot|Sealdice|SillyTavern)\b/i,
      score: 88,
      confirmUid: true,
      reason: '签名含AI机器人框架名',
    },
    {
      re: /(?:DeepSeek|deepseek)\s*(?:[-_]?(?:V3|R1|API|Bot|Agent)|驱动|自动|挂机|评论|锐评|测试|赛博)/i,
      score: 86,
      confirmUid: true,
      reason: '签名标注DeepSeek驱动/挂机',
    },
    {
      re: /(?:AI|人工智能|大模型|赛博|全自动)\s*(?:自动回复|评论机器人|自动评论|巡逻机?|挂机号?|托管|嘴替|测试号|数字生命|数字分身|赛博分身|观察员|赛博宠物)/i,
      score: 86,
      confirmUid: true,
      reason: '签名自曝AI自动回复/托管',
    },
    {
      re: /(?:言论不代表(?:号主|本人)|AI生成(?:内容|评论)|有问题(?:请)?(?:私信|联系)号主|机器人测试中|这是一个\s*(?:AI|bot|机器人)|硅基生命观察|自动冲浪中)/i,
      score: 86,
      confirmUid: true,
      reason: '签名含Bot免责声明',
    },
    {
      re: /\bdeepseek\b/i,
      score: 60,
      confirmUid: false,
      reason: '签名提及DeepSeek',
    },
  ];

  const BIO_AGENT_UNAME_PATTERNS = [
    {
      re: /(?:AI视频小助理|AI课代表|评论机器人|自动回复机器人|DeepSeek(?:小助手|助手|锐评|课代表|Bot)?)/i,
      score: 82,
      confirmUid: true,
      reason: '昵称直标AI助手/机器人',
    },
    {
      re: /(?:[-_ ]bot|智能体|自动嘴替|AI嘴替|赛博分身)$/i,
      score: 70,
      confirmUid: true,
      reason: '昵称带Bot/智能体后缀',
    },
    {
      re: /^.{1,10}的\s*[bB]站(?:账号|号)$/,
      score: 48,
      confirmUid: false,
      reason: '昵称为“xx的b站账号”挂机号格式',
    },
  ];

  // 3. 伪装路人的 DeepSeek 腔调、生成残留与 2.0 伪口语双簧特征
  const DEEPSEEK_HARD_PATTERNS = [
    {
      re: /(?:^|\n)\s*(?:[-*•]|\d+[.、])\s*\*\*[^*\n]{1,32}\*\*\s*[：:]/,
      score: 80,
      reason: 'Markdown列表加粗格式裸露',
    },
    {
      re: /\*\*[^*\n]{2,36}\*\*/,
      score: 58,
      reason: '评论含未渲染Markdown星号加粗',
    },
    {
      re: /(?:^|\n)#{1,4}\s+\S+/,
      score: 58,
      reason: '评论含Markdown标题符(#)',
    },
    {
      re: /(?:作为(?:一名|一个)?(?:AI|人工智能|大语言模型|语言模型)|我的知识库截至|无法直接观看视频|根据(?:您|你)?提供的(?:视频)?(?:标题|字幕|简介|文本)|作为一个AI助手)/i,
      score: 92,
      reason: 'AI身份自曝/提示词泄露',
    },
    {
      re: /(?:429\s*Too\s*Many\s*Requests|402\s*Insufficient\s*Balance|API\s*请求失败|rate_limit_reached|context_length_exceeded|Request\s*timed\s*out|抱歉，我无法(?:回答|满足|提供))/i,
      score: 92,
      reason: 'Bot接口报错/拒答话术泄露',
    },
    // DeepSeek 2.0 伪口语双簧高置信度模板
    {
      re: /「[^」\n]{2,16}」这条我收下了|(?:这条|这招|这个|这句)(?:我|先)?(?:收下了|收好|记下了|偷走了)\s*——/,
      score: 78,
      reason: '“这条我收下了/这招先收好——”AI双簧接话模板',
    },
    {
      re: /这个我没想到[，,]\s*比(?:只写|光写|单纯写)(?:「[^」\n]{2,20}」|“[^”\n]{2,20}”)/,
      score: 82,
      reason: '“这个我没想到，比只写「xx」实在”AI双簧模板',
    },
    {
      re: /^看完只想说一句[：:]\s*最(?:要紧|关键|核心|重要|烦|难|怕)的不是/,
      score: 72,
      reason: '“看完只想说一句：最…的不是…”AI开场模板',
    },
  ];

  // DeepSeek 1.0 & 2.0 句式骨架
  const DEEPSEEK_RHETORIC_PATTERNS = [
    {
      re: /「[^」\n]{2,16}」[^。！？\n]{0,36}——|——[^。！？\n]{0,36}「[^」\n]{2,16}」/,
      score: 48,
      reason: '「直角引号」搭配破折号(——)典型AI句式',
    },
    {
      re: /——[^。！？\n]{3,48}[，,]\s*比[^，。！？\n]{2,20}(?:稳|实在|省力(?:点)?|省事|划算|靠谱|好使|高得多|强得多|管用)[。！!]?/,
      score: 56,
      reason: '“——…，比…稳/实在/高得多”AI破折号比较句式',
    },
    {
      re: /\d+\s*(?:秒|分\d*秒?)那段的[「“][^」”\n]{2,16}[」”]/,
      score: 42,
      reason: '“XX秒那段的「…」”脚本抓取模板',
    },
    {
      re: /^(?:这条最该置顶\s*\+\s*1|太对了|对)[，,]\s*[^。！？\n]{2,26}(?:——|最(?:烦|难|怕|要紧)的不是)/,
      score: 46,
      reason: 'AI楼中楼捧场附和+破折号/对仗模板',
    },
    {
      re: /^这条最该置顶\s*\+\s*1[，,]/,
      score: 36,
      reason: '“这条最该置顶+1”捧场起手式',
    },
    {
      re: /(?:最(?:要紧|关键|核心|重要|烦|难|怕|讽刺|扎心|要命)的|问题从来)不是[^，。！？\n]{2,24}，\s*是[^，。！？\n]{2,34}/,
      score: 30,
      reason: '“最…的不是…，是…”伪口语二元对仗',
    },
    {
      re: /等于(?:让(?:它|自己|人)在[^，。！？\n]{2,24}|给了自己一个[^，。！？\n]{2,22}|给[^，。！？\n]{1,12}(?:装了|加了|留了)个?[^，。！？\n]{2,16})/,
      score: 28,
      reason: '“等于让它在/给了自己一个…”AI比喻句式',
    },
    {
      re: /不是(?:在|因为|为了)?[^，。！？\n]{2,26}，\s*而是(?:在|因为|为了)?[^，。！？\n]{2,34}/,
      score: 26,
      reason: '“不是…而是…”典型对仗句式',
    },
    {
      re: /与其说是[^，。！？\n]{2,24}，\s*不如说是[^，。！？\n]{2,28}/,
      score: 26,
      reason: '“与其说…不如说…”升华句式',
    },
    {
      re: /表面上(?:看|是|在讲)?[^，。！？\n]{2,24}，\s*(?:实际上|本质上|实则|内核)(?:是|却在讲|却是)?[^，。！？\n]{2,30}/,
      score: 26,
      reason: '“表面上…本质上…”剖析句式',
    },
    {
      re: /所谓的[^，。！？\n]{2,20}，\s*(?:不过是|无非是|本质上就是|其实只是)[^，。！？\n]{2,28}/,
      score: 25,
      reason: '“所谓的…不过是…”解构句式',
    },
    {
      re: /当[^，。！？\n]{2,22}(?:沦为|异化为|变成|成为)[^，。！？\n]{2,22}，\s*[^，。！？\n]{2,26}(?:就已经|便已经|注定)/,
      score: 26,
      reason: '“当…沦为…就已经…”宏大句式',
    },
    {
      re: /你以为(?:他|她|它|这)?是在[^，。！？\n]{2,20}，\s*(?:其实|实际上|殊不知)(?:他|她|它|这)?(?:是在|只是)?[^，。！？\n]{2,26}/,
      score: 24,
      reason: '“你以为是在…其实…”反转模板',
    },
    {
      re: /这不仅仅(?:是|关乎|是一场)[^，。！？\n]{2,24}，\s*更(?:是|关乎|像是一场)[^，。！？\n]{2,30}/,
      score: 24,
      reason: '“不仅仅…更是…”排比拔高',
    },
    {
      re: /(?:真正让人[^，。！？\n]{1,14}|最(?:讽刺|荒诞|可怕|可悲|扎心|吊诡))的(?:从来)?不是[^，。！？\n]{2,22}，\s*而是[^，。！？\n]{2,28}/,
      score: 28,
      reason: '“最…的从来不是…而是”金句模板',
    },
    {
      re: /从[^，。！？\n]{2,18}到[^，。！？\n]{2,18}，\s*(?:变的|改变的)是[^，。！？\n]{2,18}，\s*不变的是[^，。！？\n]{2,22}/,
      score: 26,
      reason: '“从…到…变的是…不变的是…”排比',
    },
    {
      re: /(?:本质上是一场关于[^，。！？\n]{2,20}的[^，。！？\n]{2,12}|这大概就是所谓的[^，。！？\n]{2,18}吧|或许这就是[^，。！？\n]{2,20}真正的意义)[。！!]?\s*$/,
      score: 22,
      reason: '典型AI结尾升华感慨',
    },
  ];

  // 一类强AI八股词
  const DEEPSEEK_TIER1_BUZZWORDS = [
    '底层逻辑',
    '颗粒度',
    '宏大叙事',
    '时代切片',
    '同频共振',
    '镜像投射',
    '逻辑闭环',
    '赛博赎罪券',
    '赛博止痛药',
    '存在主义',
    '温情脉脉',
    '振聋发聩',
    '耐人寻味',
    '解构',
    '祛魅',
    '隐喻',
    '注脚',
    '锚点',
    '底色',
    '张力',
    '吊诡',
    '异化',
  ];

  // 二类次强AI高频词
  const DEEPSEEK_TIER2_BUZZWORDS = [
    '情绪价值',
    '信息茧房',
    '降维打击',
    '精神内耗',
    '荒诞感',
    '消费主义',
    '幸存者偏差',
    '自我感动',
    '草台班子',
    '赛博牛马',
    '恰恰相反',
    '某种意义上',
    '换句话说',
    '某种程度上',
    '说白了',
    '路标',
    '护栏',
    '叙事',
    '荒诞',
    '切片',
    '共振',
    '投射',
    '闭环',
  ];

  const DEEPSEEK_BUZZWORDS = [...DEEPSEEK_TIER1_BUZZWORDS, ...DEEPSEEK_TIER2_BUZZWORDS];

  const QUOTED_CONCEPT_GLOBAL_RE = /(?:[“"][^”"\n，。！？]{2,10}[”"]|「[^」\n，。！？]{2,12}」)/g;

  const SUMMARY_LIST_RE = /(?:(?:^|\n|\s)(?:1[.、]|①|第一[，、：:])[\s\S]{6,}(?:2[.、]|②|第二[，、：:])[\s\S]{6,}(?:3[.、]|③|第三[，、：:]))/;
  const SUMMARY_WRAPPER_RE = /(?:省流总结|课代表总结|视频(?:核心)?总结|核心要点如下|总的来说[，：:]|总而言之[，：:]|综上所述[，：:]|看完这期视频[，,]不得不(?:说|感叹))/;

  // 4. @AI 召唤刷屏指令特征
  const AI_SUMMON_BOT_RE = /@\s*(?:豆包|评论罗伯特|AI视频小助理|AI课代表|视频AI总结|AI总结小助手|DeepSeek|deepseek|Kimi|元宝|腾讯元宝|通义千问|千问|文心一言|智谱清言|Grok|ChatGPT|讯飞星火|蓝色大肥鱼|[^\s@，。！？]{0,10}(?:的爱鱼|养的鱼|大肥鱼|哦鲸鲸))(?=[\s，。！？,.!?:：]|$)/i;
  const AI_SUMMON_SHORT_CMD_RE = /^\s*(?:@[\w\u4e00-\u9fa5_-]+\s*){1,4}(?:省流|总结一下|帮我总结|概括一下|课代表总结|锐评一下|分析一下|你在这么|在吗|出来总结)\s*[？?！!。~]*$/;

  const HUMAN_CALLOUT_IMMUNITY_RE = /(?:你们都是\s*deepseek\s*吗|全是\s*(?:ai|deepseek|机器人|人机)|两个\s*(?:ai|机器人)\s*在|怎么全是\s*(?:ai|鱼|机器人)|哪来的懒鱼)/i;

  const HUMAN_COLLOQUIAL_RE = /(?:哈哈哈哈|笑死我了|笑不活了|卧槽|牛逼|绷不住了|不是哥们|啊这|好家伙|草哈哈|救命哈哈|纯路人|前排围观|火钳刘明|下次一定|6666|香迷糊了|看饿了|下饭神器|你们都是\s*deepseek\s*吗|你们在说什么呀|全是人机|两个AI在|哪来的懒鱼)/i;
  const MULTI_BILI_EMOJI_RE = /\[[^\[\]\n]{1,10}\][\s\S]{0,40}\[[^\[\]\n]{1,10}\]/;

  const exported = {
    CATEGORY_META,
    BUILTIN_PRESET_KEYWORDS,
    DAFEIYU_PROFILE_PATTERNS,
    DAFEIYU_TEXT_PATTERNS,
    BIO_AGENT_SIGN_PATTERNS,
    BIO_AGENT_UNAME_PATTERNS,
    DEEPSEEK_HARD_PATTERNS,
    DEEPSEEK_RHETORIC_PATTERNS,
    DEEPSEEK_TIER1_BUZZWORDS,
    DEEPSEEK_TIER2_BUZZWORDS,
    DEEPSEEK_BUZZWORDS,
    QUOTED_CONCEPT_GLOBAL_RE,
    SUMMARY_LIST_RE,
    SUMMARY_WRAPPER_RE,
    AI_SUMMON_BOT_RE,
    AI_SUMMON_SHORT_CMD_RE,
    HUMAN_CALLOUT_IMMUNITY_RE,
    HUMAN_COLLOQUIAL_RE,
    MULTI_BILI_EMOJI_RE,
  };

  if (typeof module === 'object' && module && module.exports) {
    module.exports = exported;
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
    root.__BAK_CORE__.rules = exported;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
