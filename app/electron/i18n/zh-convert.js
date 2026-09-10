import { getCurrentLocale } from '../locale.js';

let converter = null;
let loading = null;

async function getConverter() {
  if (converter) return converter;
  if (!loading) {
    loading = import('opencc-js')
      .then(({ Converter }) => {
        converter = Converter({ from: 'cn', to: 'tw' });
        return converter;
      })
      .catch((e) => {
        loading = null; // 失败可重试
        throw e;
      });
  }
  return loading;
}

/** 界面 zh-TW 时把简体正文转繁体；失败降级返回原文。 */
export async function toTraditional(text) {
  if (getCurrentLocale() !== 'zh-TW') return text;
  try {
    const c = await getConverter();
    return c(text);
  } catch {
    return text; // 降级：不阻塞，输出简体原文
  }
}
