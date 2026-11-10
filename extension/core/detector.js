/**
 * Bili-AI-Killer — Multi-Dimensional Heuristic Scoring Engine (v2.0)
 * Zero DOM dependencies. Runs identically in Browser MAIN world, Service Worker, and Node.js tests.
 */
(function initDetectorScope(root) {
  'use strict';

  const rules =
    (root && root.__BAK_CORE__ && root.__BAK_CORE__.rules) ||
    (typeof require === 'function' ? require('./rules.js') : null);

  if (!rules) {
    throw new Error('[Bili-AI-Killer] rules module must be loaded before detector.js');
  }

  const SENSITIVITY_THRESHOLDS = {
    relaxed: 75,
    standard: 55,
    strict: 40,
  };

  const DEFAULT_SETTINGS = {
    enabled: true,
    displayMode: 'hide', // 'hide' (彻底消失) | 'collapse' (极简折叠条)
    sensitivity: 'standard', // 'relaxed' | 'standard' | 'strict'
    protectUpper: true,
    useBuiltinPresets: true,
    categories: {
      persona_dafeiyu: true,
      bio_agent: true,
      deepseek_style: true,
      ai_summon: true,
    },
    customKeywords: [...(rules.BUILTIN_PRESET_KEYWORDS || [])],
    whitelistUids: [],
    blacklistUids: [],
    llm: {
      enabled: false,
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: '',
      model: 'deepseek-chat',
      aggressiveScan: false,
    },
  };

  function normalizeUidList(list) {
    if (!Array.isArray(list)) return [];
    const seen = new Set();
    const out = [];
    for (const item of list) {
      const s = String(item || '').trim();
      if (/^\d+$/.test(s) && !seen.has(s)) {
        seen.add(s);
        out.push(s);
      }
    }
    return out;
  }

  function normalizeKeywordList(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    const seen = new Set();
    for (const raw of list) {
      const s = String(raw || '').trim();
      if (s && !seen.has(s)) {
        seen.add(s);
        out.push(s);
      }
    }
    return out;
  }

  function normalizeSettings(partial) {
    const src = partial && typeof partial === 'object' ? partial : {};
    const cats = src.categories && typeof src.categories === 'object' ? src.categories : {};
    const llmSrc = src.llm && typeof src.llm === 'object' ? src.llm : {};

    const displayMode = src.displayMode === 'collapse' ? 'collapse' : 'hide';
    const sensitivity = Object.prototype.hasOwnProperty.call(SENSITIVITY_THRESHOLDS, src.sensitivity)
      ? src.sensitivity
      : 'standard';

    const hasCustomList = Array.isArray(src.customKeywords) && src.customKeywords.length > 0;
    const customKeywords = hasCustomList
      ? normalizeKeywordList(src.customKeywords)
      : src.useBuiltinPresets === false
        ? []
        : normalizeKeywordList(rules.BUILTIN_PRESET_KEYWORDS || []);

    const normalized = {
      enabled: src.enabled !== false,
      displayMode,
      sensitivity,
      protectUpper: src.protectUpper !== false,
      useBuiltinPresets: src.useBuiltinPresets !== false,
      categories: {
        persona_dafeiyu: cats.persona_dafeiyu !== false,
        bio_agent: cats.bio_agent !== false,
        deepseek_style: cats.deepseek_style !== false,
        ai_summon: cats.ai_summon !== false,
      },
      customKeywords,
      whitelistUids: normalizeUidList(src.whitelistUids),
      blacklistUids: normalizeUidList(src.blacklistUids),
      llm: {
        enabled: Boolean(llmSrc.enabled),
        provider: String(llmSrc.provider || DEFAULT_SETTINGS.llm.provider),
        baseUrl: String(llmSrc.baseUrl || DEFAULT_SETTINGS.llm.baseUrl).trim(),
        apiKey: String(llmSrc.apiKey || '').trim(),
        model: String(llmSrc.model || DEFAULT_SETTINGS.llm.model).trim(),
        aggressiveScan: Boolean(llmSrc.aggressiveScan),
      },
    };

    Object.defineProperty(normalized, '__normalized', { value: true, enumerable: false });
    Object.defineProperty(normalized, '__compiledKeywords', {
      value: customKeywords.map(compileCustomRule).filter(Boolean),
      enumerable: false,
    });
    return normalized;
  }

  function compileCustomRule(patternStr) {
    const trimmed = String(patternStr || '').trim();
    if (!trimmed) return null;
    if (trimmed.startsWith('/') && trimmed.lastIndexOf('/') > 1) {
      const lastSlash = trimmed.lastIndexOf('/');
      const body = trimmed.slice(1, lastSlash);
      const flags = trimmed.slice(lastSlash + 1).replace(/[^gimsuy]/g, '');
      try {
        return { re: new RegExp(body, flags), label: trimmed };
      } catch (_err) {
        return null;
      }
    }
    return { plain: trimmed.toLowerCase(), label: trimmed };
  }

  const TIER1_SET = new Set(rules.DEEPSEEK_TIER1_BUZZWORDS || []);
  const SORTED_BUZZWORDS = [...rules.DEEPSEEK_BUZZWORDS].sort((a, b) => b.length - a.length);

  function findDistinctBuzzwords(text) {
    if (!text) return [];
    let working = text;
    const matched = [];
    for (const word of SORTED_BUZZWORDS) {
      if (working.includes(word)) {
        matched.push(word);
        working = working.split(word).join(' ');
      }
    }
    return matched;
  }

  function getCategoryLabel(catId) {
    return (rules.CATEGORY_META[catId] && rules.CATEGORY_META[catId].shortLabel) || 'AI疑似';
  }

  function evaluateComment(comment, rawSettings, context = {}) {
    const settings = rawSettings && rawSettings.__normalized ? rawSettings : normalizeSettings(rawSettings);
    const threshold = SENSITIVITY_THRESHOLDS[settings.sensitivity] || SENSITIVITY_THRESHOLDS.standard;

    if (!settings.enabled || !comment) {
      return {
        action: 'allow',
        score: 0,
        threshold,
        primaryCategory: null,
        categoryLabel: null,
        reasons: [],
        confirmUidAsBot: false,
      };
    }

    const uid = comment.uid ? String(comment.uid).trim() : '';
    const uname = String(comment.uname || '').trim();
    const sign = String(comment.sign || '').trim();
    const message = String(comment.message || '').trim();
    const ctime = Number(comment.ctime) || 0;

    const currentUserUid = context.currentUserUid ? String(context.currentUserUid).trim() : '';
    const upperUid = context.upperUid ? String(context.upperUid).trim() : '';

    // Priority 0: Self, UP主, and manual Whitelist protection
    if (uid) {
      if (currentUserUid && uid === currentUserUid) {
        return { action: 'allow', score: 0, threshold, primaryCategory: null, categoryLabel: null, reasons: [], confirmUidAsBot: false };
      }
      if (settings.protectUpper && upperUid && uid === upperUid) {
        return { action: 'allow', score: 0, threshold, primaryCategory: null, categoryLabel: null, reasons: [], confirmUidAsBot: false };
      }
      if (settings.whitelistUids.includes(uid)) {
        return { action: 'allow', score: 0, threshold, primaryCategory: null, categoryLabel: null, reasons: [], confirmUidAsBot: false };
      }
    }

    // Protect real humans asking "你们都是deepseek吗？"
    if (message && /(?:你们都是\s*deepseek\s*吗|全是\s*(?:ai|deepseek|机器人|人机)|两个\s*(?:ai|机器人)\s*在)/i.test(message)) {
      return { action: 'allow', score: 0, threshold, primaryCategory: null, categoryLabel: null, reasons: [], confirmUidAsBot: false };
    }

    // Priority 1: Manual Blacklist & Confirmed Session AI UID cache
    if (uid && settings.blacklistUids.includes(uid)) {
      return {
        action: 'block',
        score: 100,
        threshold,
        primaryCategory: 'blacklist',
        categoryLabel: getCategoryLabel('blacklist'),
        reasons: ['手动黑名单UID'],
        confirmUidAsBot: true,
      };
    }

    if (uid && context.confirmedBotUids && context.confirmedBotUids.has(uid)) {
      return {
        action: 'block',
        score: 95,
        threshold,
        primaryCategory: 'bio_agent',
        categoryLabel: getCategoryLabel('bio_agent'),
        reasons: ['同账号在本页已实锤为AI号'],
        confirmUidAsBot: true,
      };
    }

    const categoryScores = {
      persona_dafeiyu: 0,
      bio_agent: 0,
      deepseek_style: 0,
      ai_summon: 0,
    };
    const reasons = [];
    let hasHardEvidence = false;
    let confirmUidAsBot = false;

    const addHit = (cat, pts, reason, hard = false, confirmUid = false) => {
      categoryScores[cat] += pts;
      if (reason && !reasons.includes(reason)) {
        reasons.push(reason);
      }
      if (hard) hasHardEvidence = true;
      if (confirmUid) confirmUidAsBot = true;
    };

    // Category 1: 大肥鱼 / 鲸鱼娘 / 赛博鱼塘 / 养鱼 2.0 人设
    if (settings.categories.persona_dafeiyu) {
      const profileBlob = `${uname} ${sign}`;
      for (const item of rules.DAFEIYU_PROFILE_PATTERNS) {
        if (item.re.test(profileBlob)) {
          addHit('persona_dafeiyu', item.score, item.reason, true, true);
        }
      }
      for (const item of rules.DAFEIYU_TEXT_PATTERNS) {
        if (item.re.test(message)) {
          addHit('persona_dafeiyu', item.score, item.reason, item.score >= 65, item.score >= 70);
        }
      }
    }

    // Category 2: 简介 / 昵称自曝 AI Agent 挂机号
    if (settings.categories.bio_agent) {
      if (sign) {
        for (const item of rules.BIO_AGENT_SIGN_PATTERNS) {
          if (item.re.test(sign)) {
            addHit('bio_agent', item.score, item.reason, item.score >= 75, Boolean(item.confirmUid));
            break;
          }
        }
      }
      if (uname) {
        for (const item of rules.BIO_AGENT_UNAME_PATTERNS) {
          if (item.re.test(uname)) {
            addHit('bio_agent', item.score, item.reason, item.score >= 65, Boolean(item.confirmUid));
            break;
          }
        }
      }
    }

    // Category 4: @AI 召唤刷屏指令
    if (settings.categories.ai_summon && message) {
      let summonText = message;
      if (Array.isArray(comment.atNames) && comment.atNames.length > 0) {
        const extraMentions = comment.atNames.map((n) => `@${n}`).join(' ');
        summonText = `${extraMentions} ${message}`;
      }
      if (rules.AI_SUMMON_BOT_RE.test(summonText)) {
        addHit('ai_summon', 75, '呼叫@AI/鱼塘机器人指令', true, false);
      } else if (message.length <= 42 && rules.AI_SUMMON_SHORT_CMD_RE.test(message)) {
        addHit('ai_summon', 70, '@召唤课代表/省流指令', true, false);
      }
    }

    // Category 3: 伪装路人的 DeepSeek 腔调 / 双簧互吹 / 秒评课代表
    if (settings.categories.deepseek_style && message) {
      for (const item of rules.DEEPSEEK_HARD_PATTERNS) {
        if (item.re.test(message)) {
          addHit('deepseek_style', item.score, item.reason, true, item.score >= 72);
        }
      }

      let rhetoricHits = 0;
      for (const item of rules.DEEPSEEK_RHETORIC_PATTERNS) {
        if (item.re.test(message)) {
          rhetoricHits += 1;
          addHit('deepseek_style', item.score, item.reason, false, false);
        }
      }
      if (rhetoricHits >= 2) {
        addHit('deepseek_style', 12, '多重AI排比/对仗句式叠加', false, true);
      }

      // DeepSeek 2.0 伪口语：破折号(——) + 比较/捧场/结论句式组合
      if (message.includes('——')) {
        const hasComparisonTail = /(?:比(?:只写|一口气|一开始)[^，。！？\n]{1,16}(?:高得多|省力|实在|强)|回头(?:真不知道|能看见|纠正的成本))/.test(message);
        if (hasComparisonTail) {
          addHit('deepseek_style', 32, '破折号(——)搭配“回头…比…实在/高得多”AI句式', false, false);
        }
      }

      // DeepSeek buzzword cluster density
      const buzzwords = findDistinctBuzzwords(message);
      const tier1Matches = buzzwords.filter((w) => TIER1_SET.has(w));
      const weightedBuzzCount = tier1Matches.length * 1.35 + (buzzwords.length - tier1Matches.length) * 0.9;

      if (buzzwords.length >= 4 || weightedBuzzCount >= 3.8) {
        addHit('deepseek_style', 62, `重度DeepSeek八股词簇(${buzzwords.slice(0, 3).join('/')}等)`, true, true);
      } else if (buzzwords.length === 3 || weightedBuzzCount >= 2.6) {
        addHit('deepseek_style', 44, `高频AI锐评词密集(${buzzwords.slice(0, 3).join('/')})`, false, false);
      } else if (buzzwords.length === 2) {
        const pts = tier1Matches.length >= 1 ? 26 : 18;
        addHit('deepseek_style', pts, `高频AI锐评词共现(${buzzwords.slice(0, 2).join('/')})`, false, false);
      } else if (buzzwords.length === 1 && rhetoricHits >= 1) {
        const pts = tier1Matches.length === 1 ? 18 : 12;
        addHit('deepseek_style', pts, `对仗骨架搭配高频词(${buzzwords[0]})`, false, false);
      }

      // Short double-quotes / corner-quotes concept coining
      if (rules.QUOTED_CONCEPT_GLOBAL_RE && message.length <= 450) {
        const quotedMatches = message.match(rules.QUOTED_CONCEPT_GLOBAL_RE) || [];
        if (quotedMatches.length >= 3) {
          addHit('deepseek_style', 28, `密集引号造词(${quotedMatches.slice(0, 3).join('')})`, false, false);
        } else if (quotedMatches.length === 2 && (rhetoricHits >= 1 || buzzwords.length >= 1)) {
          addHit('deepseek_style', 16, '引号概念词搭配AI句式', false, false);
        } else if (quotedMatches.length >= 1 && message.includes('「') && rhetoricHits >= 1) {
          addHit('deepseek_style', 16, '直角引号「」搭配AI对仗句式', false, false);
        }
      }

      // Structured multi-point summary + wrapper
      const hasList = rules.SUMMARY_LIST_RE.test(message);
      const hasWrapper = rules.SUMMARY_WRAPPER_RE.test(message);
      if (hasList && hasWrapper) {
        addHit('deepseek_style', 62, '典型AI分点总结课代表模板', false, false);
      } else if (hasList) {
        addHit('deepseek_style', 26, '工整分点罗列结构', false, false);
      } else if (hasWrapper && message.length >= 60) {
        addHit('deepseek_style', 20, '总结式套话开头/结尾', false, false);
      }

      // Speed-of-light long structured comment right after video publication
      const videoPubdate = Number(context.videoPubdate) || 0;
      if (ctime > 0 && videoPubdate > 0 && ctime >= videoPubdate) {
        const deltaSec = ctime - videoPubdate;
        if (deltaSec <= 90 && message.length >= 75) {
          addHit('deepseek_style', 50, `视频发布${deltaSec}秒内光速长评`, true, true);
        } else if (deltaSec <= 180 && message.length >= 140 && (hasList || hasWrapper || rhetoricHits > 0)) {
          addHit('deepseek_style', 30, '视频刚发布即发长篇总结', false, false);
        }
      }

      // Thread context boost: if replying inside an already-confirmed AI thread with echo/agreement style
      if (context.parentThreadIsAi && message.length >= 22) {
        if (/^(?:这条最该置顶|对[，,]|太对了[，,]|确实[，,])/.test(message) || message.includes('——') || message.includes('「')) {
          addHit('deepseek_style', 35, '在AI主楼下使用AI句式捧场双簧', true, true);
        }
      }

      // Textbook punctuation polish bonus
      if (categoryScores.deepseek_style >= 22 && message.length >= 42 && message.length <= 500) {
        const formalPunctCount = (message.match(/[，。；：——“”「」]/g) || []).length;
        const endsCleanly = /[。！？!?”]$/.test(message);
        const hasAsciiMess = /[a-zA-Z]{12,}|[?？!！]{3,}|哈哈哈/.test(message);
        if (formalPunctCount >= 4 && endsCleanly && !hasAsciiMess) {
          addHit('deepseek_style', 14, '高工整度书面标点节奏', false, false);
        }
      }
    }

    // Priority 1.5: Built-in Preset & Custom user keywords / regexes
    // Evaluated after built-in categories so if it didn't already hit, preset/custom keyword catches it
    let totalScore =
      categoryScores.persona_dafeiyu +
      categoryScores.bio_agent +
      categoryScores.deepseek_style +
      categoryScores.ai_summon;

    if (totalScore < threshold && settings.customKeywords.length > 0) {
      const compiledList =
        settings.__compiledKeywords || settings.customKeywords.map(compileCustomRule).filter(Boolean);
      const combinedRaw = `${uname}\n${sign}\n${message}`;
      const combinedLower = combinedRaw.toLowerCase();
      for (const compiled of compiledList) {
        const matched = compiled.re ? compiled.re.test(combinedRaw) : combinedLower.includes(compiled.plain);
        if (matched) {
          return {
            action: 'block',
            score: 100,
            threshold,
            primaryCategory: 'custom_keyword',
            categoryLabel: getCategoryLabel('custom_keyword'),
            reasons: [`命中屏蔽词: ${compiled.label}`],
            confirmUidAsBot: true,
          };
        }
      }
    }

    // Human colloquialism safeguard (only when NO hard evidence exists)
    if (!hasHardEvidence && totalScore > 0 && message) {
      if (rules.HUMAN_COLLOQUIAL_RE.test(message) || rules.MULTI_BILI_EMOJI_RE.test(message)) {
        totalScore = Math.max(0, totalScore - 24);
      }
    }

    let primaryCategory = null;
    let maxCatScore = 0;
    for (const [cat, val] of Object.entries(categoryScores)) {
      if (val > maxCatScore) {
        maxCatScore = val;
        primaryCategory = cat;
      }
    }

    if (totalScore >= 70) {
      confirmUidAsBot = true;
    }

    if (totalScore >= threshold) {
      return {
        action: 'block',
        score: totalScore,
        threshold,
        primaryCategory: primaryCategory || 'deepseek_style',
        categoryLabel: getCategoryLabel(primaryCategory || 'deepseek_style'),
        reasons,
        confirmUidAsBot,
      };
    }

    const llmReady = Boolean(settings.llm.enabled && settings.llm.apiKey && settings.llm.baseUrl);
    if (llmReady && message.length >= 18) {
      const inGrayZone = totalScore >= 20;
      const inAggressiveZone =
        settings.llm.aggressiveScan &&
        message.length >= 45 &&
        !rules.HUMAN_COLLOQUIAL_RE.test(message);

      if (inGrayZone || inAggressiveZone) {
        return {
          action: 'pending_llm',
          score: totalScore,
          threshold,
          primaryCategory: primaryCategory || 'deepseek_style',
          categoryLabel: getCategoryLabel(primaryCategory || 'deepseek_style'),
          reasons,
          confirmUidAsBot: false,
        };
      }
    }

    return {
      action: 'allow',
      score: totalScore,
      threshold,
      primaryCategory,
      categoryLabel: primaryCategory ? getCategoryLabel(primaryCategory) : null,
      reasons,
      confirmUidAsBot: false,
    };
  }

  const exported = {
    SENSITIVITY_THRESHOLDS,
    DEFAULT_SETTINGS,
    BUILTIN_PRESET_KEYWORDS: rules.BUILTIN_PRESET_KEYWORDS || [],
    normalizeSettings,
    evaluateComment,
    findDistinctBuzzwords,
    CATEGORY_META: rules.CATEGORY_META,
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
    root.__BAK_CORE__.detector = exported;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
