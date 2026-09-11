import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 打包前置检查：没有端点配置就不许出包。
 *
 * 宁可打包失败，也不要打出一个「装完拿不到 Key」的包——那种包发给同事
 * 之后，排查成本远高于在这里失败一次。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const PATH = join(HERE, '..', 'electron', 'endpoint.built.json');

const problems = [];
let j;
try {
  j = JSON.parse(readFileSync(PATH, 'utf8'));
} catch {
  problems.push(`读不到或不是合法 JSON：${PATH}`);
}

// 只有「读到了、且解析结果是普通对象」才进入字段校验。
// 用 typeof/Array.isArray 显式判断，而不是 if (j) 的真值性——后者会让
// 0 / false / "" / null 这类解析结果整段跳过校验，随后 problems 仍为空，
// 于是脚本在坏输入上 fail-open 放行打包。这正是本脚本绝不能干的事。
if (problems.length === 0) {
  if (j === null || typeof j !== 'object' || Array.isArray(j)) {
    problems.push(
      `配置根节点不是 JSON 对象（应是 { "endpoint": ..., "token": ... }）—— 实际内容：${JSON.stringify(j)}`
    );
  } else {
    const endpoint = String(j.endpoint ?? '').trim();
    const token = String(j.token ?? '').trim();
    if (!endpoint) {
      problems.push('endpoint 为空');
    } else if (!endpoint.startsWith('https://')) {
      problems.push(`endpoint 必须是 https:// —— 当前：${endpoint}`);
    } else {
      // endpoint 是**完整 URL**（本身即 .../config），客户端原样 fetch、不做任何路径拼接。
      // 所以这里必须验「能解析 + 有主机名 + 路径以 /config 结尾」：只查 https:// 前缀
      // 会让 https://host（漏了 /config，等于按 base 地址填）溜过检查，装到客户端后
      // 每台机器都 404、全部弹「授权信息异常」——正是打包前就该拦下的那类包。
      let u = null;
      try {
        u = new URL(endpoint);
      } catch {
        u = null;
      }
      if (!u) problems.push(`endpoint 不是合法 URL —— 当前：${endpoint}`);
      else if (!u.hostname) problems.push(`endpoint 缺少主机名 —— 当前：${endpoint}`);
      else if (!u.pathname.endsWith('/config')) {
        problems.push(
          `endpoint 的路径必须以 /config 结尾（endpoint 是完整 URL，不是 base 地址，客户端不会补 /config）—— 当前：${endpoint}`
        );
      }
    }
    if (!token) problems.push('token 为空');
    else if (token === 'REPLACE_ME') problems.push('token 仍是样例里的占位值 REPLACE_ME');
  }
}

if (problems.length) {
  console.error(
    '[打包前置检查] 未通过：\n' +
      problems.map((p) => `  - ${p}`).join('\n') +
      '\n修复：把 app/electron/endpoint.example.json 复制为 app/electron/endpoint.built.json，填入真实 token 与**完整端点 URL**（含 /config，例如 https://host/config，客户端不会替你补路径）。'
  );
  process.exit(1);
}

// 能走到这里，说明上面「对象校验 + 字段校验」全部通过、problems 为空；
// 任何坏输入都已在前面 exit(1)，成功日志在结构上不可能出现在跳校验的路径上。
console.log(`[打包前置检查] 通过：${String(j.endpoint).trim()}`);
