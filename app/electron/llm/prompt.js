/** 构造润色请求的 system + user 两条消息。scene/tone 是 { name, description }。 */
export function buildPolishMessages(text, scene, tone) {
  const sceneLine = `场景：${scene.name}${scene.description ? `（${scene.description}）` : ''}`;
  const toneLine = `语气：${tone.name}${tone.description ? `（${tone.description}）` : ''}`;
  return {
    system:
      `你是文字润色助手。根据场景和语气改写用户文本，` +
      `只输出改写后的文本，不要解释、不要加引号、不要多余内容。\n\n` +
      `${sceneLine}\n${toneLine}`,
    user: text,
  };
}
