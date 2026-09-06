/**
 * 一次性 spike：验证百炼文本模型 deepseek-v4-pro-0813 的调用方式。
 * 用法：node spike/llm.js
 *
 * 目的：润色功能（M4）直连百炼文本模型。动手前必须先把三件事验实：
 *   1. 用哪个端点（ASR 走的是 MaaS workspace 域，文本模型未必同一个）
 *   2. 鉴权方式（Bearer / X-DashScope-Api-Key / 是否要 workspace 头）
 *   3. 流式输出的格式（SSE 的 data 行结构），逐字上屏靠它
 */

process.loadEnvFile('.env');

const KEY = process.env.DASHSCOPE_API_KEY;
const WS = process.env.DASHSCOPE_WORKSPACE_ID;
const MODEL = 'deepseek-v4-pro-0813';

if (!KEY) {
  console.error('缺少 DASHSCOPE_API_KEY（.env）');
  process.exit(1);
}

const body = {
  model: MODEL,
  messages: [
    { role: 'system', content: '你是文字润色助手。只输出润色后的文本，不要解释。' },
    { role: 'user', content: '把这句话改得正式一点：那个功能我们下周上线，你先看看有没有问题。' },
  ],
  stream: true,
};

// 依次尝试的端点。第一个成功就停。
const CANDIDATES = [
  {
    name: 'MaaS workspace 域 OpenAI 兼容',
    url: `https://${WS}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions`,
    headers: { Authorization: `Bearer ${KEY}`, 'X-DashScope-WorkSpace': WS, 'Content-Type': 'application/json' },
  },
  {
    name: '标准 dashscope OpenAI 兼容',
    url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
  },
];

async function tryEndpoint({ name, url, headers }) {
  console.log(`\n=== 尝试：${name} ===`);
  console.log(`URL: ${url}`);

  let res;
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  } catch (e) {
    console.log(`  网络错误：${e.message}`);
    return false;
  }

  console.log(`  HTTP ${res.status} ${res.statusText}`);
  const contentType = res.headers.get('content-type') ?? '';

  if (!res.ok) {
    const text = await res.text();
    console.log(`  响应：${text.slice(0, 400)}`);
    return false;
  }

  // 流式：SSE。逐行读 data: {...}
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let chunks = 0;
  let printed = 0;
  const preview = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    // SSE 事件以空行分隔
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      chunks += 1;
      try {
        const j = JSON.parse(data);
        const delta = j.choices?.[0]?.delta?.content ?? j.choices?.[0]?.message?.content ?? '';
        if (delta && printed < 1) {
          // 只打印第一块，确认结构即可
          preview.push(JSON.stringify(j).slice(0, 300));
          printed += 1;
        }
        if (delta) process.stdout.write(delta);
      } catch {
        // 非 JSON 行忽略
      }
    }
  }
  console.log(`\n  [收到 ${chunks} 个流式块]`);
  if (preview.length) console.log(`  首块结构示例：${preview[0]}`);
  return chunks > 0;
}

for (const c of CANDIDATES) {
  const ok = await tryEndpoint(c);
  if (ok) {
    console.log(`\n✔ 用这个端点：${c.name}`);
    process.exit(0);
  }
}
console.log('\n✘ 两个端点都没跑通，需要核对模型 ID 或端点在百炼控制台的配置');
process.exit(1);
