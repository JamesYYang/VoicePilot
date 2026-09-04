import { AsrClient } from './lib/asr.js';

/**
 * 链路自检：用 1 秒静音跑完整个 WebSocket 流程，不验证识别质量。
 *
 * 目的是在录音频之前先确认凭证和协议是通的 —— 否则录完一堆素材才发现
 * workspace id 拼错，白费功夫。
 */

const apiKey = process.env.DASHSCOPE_API_KEY;
const workspaceId = process.env.DASHSCOPE_WORKSPACE_ID;

if (!apiKey || !workspaceId) {
  console.error('凭证未填全。请编辑 .env 填入 DASHSCOPE_API_KEY 与 DASHSCOPE_WORKSPACE_ID');
  console.error('\n两者都在百炼控制台获取：https://bailian.console.aliyun.com/');
  console.error('注意 DASHSCOPE_WORKSPACE_ID 是业务空间 ID，不是 API Key，两者都要。');
  process.exit(1);
}

console.log(`Workspace ID: ${workspaceId}`);
console.log(`API Key:      ${apiKey.slice(0, 6)}...${apiKey.slice(-4)} (长度 ${apiKey.length})`);
console.log(`Endpoint:     wss://${workspaceId}.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference`);
console.log('');

// 1 秒静音：16kHz × 16bit × 1声道 = 32000 字节
const silence = Buffer.alloc(16000 * 2);

const client = new AsrClient({ apiKey, workspaceId });

console.log('1/3 建立 WebSocket 连接并发送 run-task...');
const t0 = Date.now();

try {
  const result = await client.recognize({ pcm: silence, chunkMs: 100 });

  const elapsed = Date.now() - t0;
  console.log(`2/3 收到 task-started 并完成音频发送 (${elapsed}ms)`);
  console.log('3/3 收到 task-finished，连接正常关闭');

  console.log('');
  console.log('✅ 链路通。凭证有效，协议交互正常。');
  console.log('');
  console.log('说明：输入是静音，所以没有识别结果是正常的 —— 本脚本只验证连通性。');
  console.log('接下来按 spike/audio/README.md 录制素材，然后跑：');
  console.log('  npm run probe -- --audio spike/audio/<name>.wav --truth spike/audio/<name>.txt');

  if (result.usage) console.log(`\n计费时长: ${result.usage.duration}s（静音也会计费，这是最后一次无意义调用）`);
} catch (err) {
  console.error(`\n❌ 失败: ${err.message}\n`);
  diagnose(err, workspaceId);
  process.exit(1);
}

function diagnose(err, workspaceId) {
  const msg = err.message;

  console.error('排查建议：');

  if (/401|403|Unexpected server response/i.test(msg)) {
    console.error('  → 凭证被拒。依次检查：');
    console.error('    1. DASHSCOPE_API_KEY 是否完整复制（sk- 开头，无多余空格）');
    console.error('    2. 该 Key 是否属于 DASHSCOPE_WORKSPACE_ID 对应的业务空间');
    console.error('    3. 账号是否已开通「实时语音识别」服务');
  } else if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(msg)) {
    console.error('  → 域名解析失败，几乎可以肯定是 DASHSCOPE_WORKSPACE_ID 填错。');
    console.error(`    当前拼接出的域名: ${workspaceId}.cn-beijing.maas.aliyuncs.com`);
    console.error('    业务空间 ID 在控制台「业务空间」页面查看，形如 ws_xxxxxxxx');
  } else if (/timeout|超时/i.test(msg)) {
    console.error('  → 超时。检查网络能否访问阿里云，以及是否被代理拦截 wss 连接。');
  } else {
    console.error('  → 未归类错误。完整堆栈：');
    console.error(err.stack);
  }
}
