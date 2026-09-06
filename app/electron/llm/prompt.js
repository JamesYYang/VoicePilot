export const SCENES = ['邮件', '即时通讯', '文档', '社媒'];
export const TONES = ['正式', '口语', '简洁', '热情'];

/** 构造润色请求的 system + user 两条消息。 */
export function buildPolishMessages(text, scene, tone) {
  return {
    system:
      `你是文字润色助手。根据场景和语气改写用户文本，` +
      `只输出改写后的文本，不要解释、不要加引号、不要多余内容。\n\n` +
      `场景：${scene}\n语气：${tone}`,
    user: text,
  };
}
