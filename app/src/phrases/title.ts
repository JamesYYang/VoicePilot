/**
 * 从正文派生选择器里那行短标签。
 *
 * 保存必须**零打断**（spec §0 决策 5），所以不起名、不弹输入框 —— 取正文的第一个
 * 非空行，超长截断。用户想改名去 Studio 的常用语页。
 *
 * 长度按码点算（Array.from）而不是 UTF-16 单元：否则一个 emoji 会被算成 2，
 * 中英混排时截断位置与用户看到的字符数对不上。
 */
export const PHRASE_TITLE_MAX = 40;

export function derivePhraseTitle(text: string): string {
  const firstLine = String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  if (!firstLine) return '';

  const chars = Array.from(firstLine);
  if (chars.length <= PHRASE_TITLE_MAX) return firstLine;
  return chars.slice(0, PHRASE_TITLE_MAX).join('') + '…';
}
