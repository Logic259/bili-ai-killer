/**
 * Bili-AI-Killer — Optional OpenAI-Compatible LLM Secondary Judge (v3.0)
 * Supports DeepSeek official API, SiliconFlow, OpenAI, Ollama, and custom endpoints.
 * Updated with DeepSeek 2.0 fake-colloquial ping-pong & cyber-fish 2.0 criteria.
 */

export const PROVIDER_PRESETS = {
  deepseek: {
    label: 'DeepSeek 官方 API',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
  },
  siliconflow: {
    label: '硅基流动 (SiliconFlow)',
    baseUrl: 'https://api.siliconflow.cn/v1',
    defaultModel: 'Qwen/Qwen2.5-7B-Instruct',
  },
  openai: {
    label: 'OpenAI 兼容接口',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
  },
  ollama: {
    label: '本地 Ollama (免Key)',
    baseUrl: 'http://localhost:11434/v1',
    defaultModel: 'qwen2.5:7b',
  },
  custom: {
    label: '自定义 OpenAI 兼容端点',
    baseUrl: '',
    defaultModel: '',
  },
};

export function buildChatCompletionsUrl(rawBaseUrl) {
  const cleaned = String(rawBaseUrl || '').trim().replace(/\/+$/, '');
  if (!cleaned) return '';
  if (/\/chat\/completions$/i.test(cleaned)) {
    return cleaned;
  }
  if (/\/v\d+(?:beta\d*)?$/i.test(cleaned)) {
    return `${cleaned}/chat/completions`;
  }
  return `${cleaned}/v1/chat/completions`;
}

export function extractJsonFromModelText(rawText) {
  const text = String(rawText || '').trim();
  if (!text) return null;

  const withoutThink = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const unfenced = withoutThink
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    return JSON.parse(unfenced);
  } catch (_e) {
    const objMatch = unfenced.match(/\{[\s\S]*\}/);
    if (objMatch) {
      try {
        return JSON.parse(objMatch[0]);
      } catch (_e2) {
        // fall through
      }
    }
    const arrMatch = unfenced.match(/\[[\s\S]*\]/);
    if (arrMatch) {
      try {
        return JSON.parse(arrMatch[0]);
      } catch (_e3) {
        return null;
      }
    }
    return null;
  }
}

const SYSTEM_PROMPT = [
  '你是B站评论区反AI挂机机器人鉴定器。请判断给定的评论是否由AI大模型(如DeepSeek/Agent挂机脚本)生成或属于@AI召唤指令。',
  '重点判定为AI(isAi=true)的特征：',
  '1. 赛博养鱼/鲸鱼娘/哦鲸鲸人设：本鲸/本鱼/我主人给我升级/评论区营业/自家鱼/讨Token/吃白饭黑话；',
  '2. 签名或昵称暴露AI/Bot/Agent/DeepSeek/AstrBot/OpenClaw/MaiMBot身份；',
  '3. DeepSeek 1.0锐评腔：强行二元对仗(不是…而是…/与其说…不如说…)、堆砌颗粒度/底层逻辑/解构/叙事/注脚/切片、机械分点总结、裸露Markdown；',
  '4. DeepSeek 2.0伪口语双簧：频繁用直角引号「」提取前文词句接话、破折号(——)后跟“比…实在/稳/高得多”或“等于给了自己一个路标/护栏”等工整比喻；',
  '5. 纯粹呼叫@豆包/@评论罗伯特/@课代表等AI总结的刷屏指令。',
  '防误伤铁律：真实人类的口语吐槽、玩梗、美食区正常讨论米饭/白饭、怀疑别人是AI的反问句、个人真实经历或认真科普讨论一律判为isAi=false。',
  '严格只输出JSON对象，格式：{"results":[{"rpid":"原样ID","isAi":true或false,"confirmUid":true或false,"reason":"10字内原因"}]}',
].join('\n');

export async function judgeCommentsBatch(items, llmConfig, fetchImpl = fetch) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const endpoint = buildChatCompletionsUrl(llmConfig && llmConfig.baseUrl);
  const apiKey = String((llmConfig && llmConfig.apiKey) || '').trim();
  const model = String((llmConfig && llmConfig.model) || 'deepseek-chat').trim();

  if (!endpoint || (!apiKey && llmConfig.provider !== 'ollama')) {
    return [];
  }

  const compactPayload = items.map((item) => ({
    rpid: String(item.rpid),
    uname: String(item.uname || '').slice(0, 30),
    sign: String(item.sign || '').slice(0, 80),
    text: String(item.message || '').slice(0, 280),
  }));

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey && apiKey !== '__CONFIGURED__') {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const requestBody = JSON.stringify({
    model,
    temperature: 0.1,
    max_tokens: 600,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify(compactPayload) },
    ],
  });

  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const resp = await fetchImpl(endpoint, {
        method: 'POST',
        headers,
        signal: controller.signal,
        body: requestBody,
      });

      if (!resp.ok) {
        if (attempt === 0 && resp.status >= 500) continue;
        throw new Error(`HTTP ${resp.status}`);
      }

      const data = await resp.json();
      const content =
        data &&
        data.choices &&
        data.choices[0] &&
        data.choices[0].message &&
        data.choices[0].message.content;

      const parsed = extractJsonFromModelText(content);
      const list = Array.isArray(parsed)
        ? parsed
        : parsed && Array.isArray(parsed.results)
          ? parsed.results
          : [];

      const verdicts = [];
      for (const row of list) {
        if (!row || !row.rpid) continue;
        verdicts.push({
          rpid: String(row.rpid),
          isAi: Boolean(row.isAi),
          confirmUid: Boolean(row.confirmUid),
          category: 'llm_judge',
          reason: String(row.reason || 'API判定为AI生成').slice(0, 28),
        });
      }
      return verdicts;
    } catch (err) {
      if (attempt === 1) throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  return [];
}

export async function testLlmConnection(llmConfig, fetchImpl = fetch) {
  const endpoint = buildChatCompletionsUrl(llmConfig && llmConfig.baseUrl);
  const apiKey = String((llmConfig && llmConfig.apiKey) || '').trim();
  const model = String((llmConfig && llmConfig.model) || '').trim();

  if (!endpoint) {
    return { ok: false, error: '请填写有效的 API Base URL' };
  }
  if (!model) {
    return { ok: false, error: '请填写模型名称（如 deepseek-chat）' };
  }
  if (!apiKey && llmConfig.provider !== 'ollama') {
    return { ok: false, error: '请填写 API Key' };
  }

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);

  try {
    const resp = await fetchImpl(endpoint, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 32,
        messages: [{ role: 'user', content: '请仅回复 JSON: {"ok":true}' }],
      }),
    });

    const latencyMs = Date.now() - start;
    if (!resp.ok) {
      let detail = '';
      try {
        const errJson = await resp.json();
        detail = (errJson && errJson.error && errJson.error.message) || '';
      } catch (_e) {
        // ignore
      }
      if (resp.status === 401) return { ok: false, error: '401 鉴权失败：API Key 无效或已过期' };
      if (resp.status === 402) return { ok: false, error: '402 账户余额不足，请检查额度' };
      if (resp.status === 404) return { ok: false, error: `404 路径或模型不存在 (${endpoint})` };
      return { ok: false, error: `HTTP ${resp.status}${detail ? `: ${detail}` : ''}` };
    }

    const data = await resp.json();
    const reply =
      (data &&
        data.choices &&
        data.choices[0] &&
        data.choices[0].message &&
        data.choices[0].message.content) ||
      'OK';

    return {
      ok: true,
      latencyMs,
      reply: String(reply).trim().slice(0, 60),
    };
  } catch (err) {
    if (err && err.name === 'AbortError') {
      return { ok: false, error: '请求超时（12秒），请检查网络或端点地址' };
    }
    return { ok: false, error: `连接异常：${(err && err.message) || String(err)}` };
  } finally {
    clearTimeout(timer);
  }
}
