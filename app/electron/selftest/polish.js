import { streamPolish } from '../llm/polish.js';

export async function runPolishSelftest() {
  console.log('[自测] 润色 LLM 流式');
  let full = '';
  let chunks = 0;
  let err = null;

  try {
    await streamPolish({
      text: '那个功能我们下周上线，你先看看有没有问题。',
      scene: { name: '邮件', description: '' },
      tone: { name: '正式', description: '' },
      onDelta: (d) => { full += d; chunks += 1; },
      onDone: () => {},
      onError: (e) => { err = e; },
    });
  } catch (e) {
    err = e;
  }

  // 多块才证明真的在流式；有内容证明模型可用
  const ok = !err && full.length > 0 && chunks > 1;
  console.log(`[自测] ${ok ? '通过' : '失败'} 块数=${chunks} 结果="${full}"`);
  if (err) console.error(`[自测] 错误：${err.message}`);
  return { ok, chunks, text: full };
}
