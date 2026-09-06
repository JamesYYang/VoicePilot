import { loadCredentials } from '../asr/config.js';
import { buildPolishMessages } from './prompt.js';

const MODEL = 'deepseek-v4-pro-0813';

/**
 * 流式润色。delta 经 onDelta 逐块交付。
 * 只取 content，reasoning_content（思维链）一律丢弃。
 */
export async function streamPolish({ text, scene, tone, onDelta, onDone, onError }) {
  const { apiKey, workspaceId } = loadCredentials();
  const { system, user } = buildPolishMessages(text, scene, tone);

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
    onError(err);
    throw err;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  // 切出完整行（含 `\n`），逐行解析 SSE；返回剩余的不完整片段。
  const drain = (s) => {
    let idx;
    while ((idx = s.indexOf('\n')) >= 0) {
      const line = s.slice(0, idx).trim();
      s = s.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;

      let j;
      try {
        j = JSON.parse(data);
      } catch {
        continue;
      }
      const delta = j.choices?.[0]?.delta?.content ?? '';
      if (delta) onDelta(delta);
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
  drain(buf);

  onDone();
}
