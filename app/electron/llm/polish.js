import { loadCredentials } from '../asr/config.js';
import { buildPolishMessages } from './prompt.js';
import '../tls-ca.js';

const MODEL = 'deepseek-v4-pro-0813';

/** 文本含 CJK 汉字 → 'zh'，否则 'en'。用于决定润色输出语言指令。 */
function detectLang(text) {
  return /[\u4e00-\u9fff]/.test(text) ? 'zh' : 'en';
}

/**
 * 流式润色。delta 经 onDelta 逐块交付。
 * 只取 content，reasoning_content（思维链）一律丢弃。
 */
export async function streamPolish({ text, scene, tone, onDelta, onDone, onError }) {
  const { apiKey, workspaceId } = loadCredentials();
  const { system, user } = buildPolishMessages(text, scene, tone, detectLang(text));

  const res = await fetch(
    `https://${workspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'X-DashScope-WorkSpace': workspaceId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        stream: true,
      }),
    }
  );

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`润色请求失败 HTTP ${res.status} ${body.slice(0, 200)}`);
    throw err;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  // 处理单行 SSE：strip → 校验 data: 前缀 → 跳过 [DONE] → JSON.parse → 提取 delta.content。
  const processLine = (line) => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (data === '[DONE]') return;

    let j;
    try {
      j = JSON.parse(data);
    } catch {
      return;
    }
    const delta = j.choices?.[0]?.delta?.content ?? '';
    if (delta) onDelta(delta);
  };

  // 切出完整行（含 `\n`），逐行解析 SSE；返回剩余的不完整片段。
  // flush=true 时，把残留的尾行（可能无 `\n`）也作为一行处理。
  const drain = (s, flush = false) => {
    let idx;
    while ((idx = s.indexOf('\n')) >= 0) {
      const line = s.slice(0, idx).trim();
      s = s.slice(idx + 1);
      processLine(line);
    }
    if (flush) {
      const tail = s.trim();
      if (tail) processLine(tail);
      s = '';
    }
    return s;
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    buf = drain(buf);
  }

  // 流结束 flush：解码器内部可能仍残留未输出的字节；处理无 `\n` 的尾行。
  buf += decoder.decode();
  drain(buf, true);

  onDone();
}
