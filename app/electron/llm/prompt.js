/**
 * 构造润色请求的 system + user 两条消息。scene/tone 是 { name, description }。
 * outputLang 由调用方按输入文本语种判定（'zh' | 'en'），决定输出语言指令的措辞。
 */
export function buildPolishMessages(text, scene, tone, outputLang = 'zh') {
  const sceneLine = `场景：${scene.name}${scene.description ? `（${scene.description}）` : ''}`;
  const toneLine = `语气：${tone.name}${tone.description ? `（${tone.description}）` : ''}`;
  const langLine = outputLang === 'en'
    ? 'Output in the same language as the user input.'
    : '输出语言与用户输入一致。';
  return {
    system:
      `你是文字润色助手。根据场景和语气改写用户文本，` +
      `只输出改写后的文本，不要解释、不要加引号、不要多余内容。\n\n` +
      `${sceneLine}\n${toneLine}\n${langLine}`,
    user: text,
  };
}
