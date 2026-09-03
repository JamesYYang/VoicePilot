import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { StreamingParaformer } from '../spike/lib/paraformer.js';

/**
 * demo 转发层。
 *
 * 存在的理由（不是为转发而转发）：浏览器的 WebSocket API 不支持自定义请求头，
 * 无法携带 Authorization，因此浏览器不能直接连百炼；而且把 API Key 放在前端
 * 等于公开。这里只做透传，不加工任何数据。
 */

const PORT = Number(process.env.PORT ?? 3000);
const HERE = dirname(fileURLToPath(import.meta.url));

// 与 spike 默认保持一致，便于 demo 与实测数据对照
const ASR_PARAMS = {
  semantic_punctuation_enabled: false, // VAD 断句，延迟优先
  inverse_text_normalization_enabled: true,
  punctuation_prediction_enabled: true,
  disfluency_removal_enabled: false,
};

const apiKey = process.env.DASHSCOPE_API_KEY;
const workspaceId = process.env.DASHSCOPE_WORKSPACE_ID;

if (!apiKey || !workspaceId) {
  console.error('缺少凭证。请在 .env 中填写 DASHSCOPE_API_KEY 与 DASHSCOPE_WORKSPACE_ID');
  console.error('（DASHSCOPE_WORKSPACE_ID 是业务空间 ID，不是 API Key，两者都需要）');
  process.exit(1);
}

const httpServer = createServer(async (req, res) => {
  const url = (req.url ?? '/').split('?')[0];

  if (url === '/' || url === '/index.html') {
    try {
      const html = await readFile(join(HERE, 'public', 'index.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`读取页面失败: ${err.message}`);
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

const wss = new WebSocketServer({ server: httpServer, path: '/asr' });

wss.on('connection', (browser) => {
  let session = null;

  const send = (obj) => {
    if (browser.readyState === browser.OPEN) browser.send(JSON.stringify(obj));
  };

  console.log(`[浏览器] 连接 (当前 ${wss.clients.size} 个)`);

  browser.on('message', async (data, isBinary) => {
    // 音频：二进制帧，直接透传
    if (isBinary) {
      session?.sendAudio(data);
      return;
    }

    let msg;
    try {
      msg = JSON.parse(data.toString('utf8'));
    } catch {
      return;
    }

    if (msg.type === 'start') {
      if (session) return; // 已在会话中，忽略重复 start

      // onError 与 start() 的 catch 都可能拿到同一个错误：task-failed 时
      // 前者先触发，连接层错误（握手失败/超时）则只有后者。用标记避免重复报错。
      let notified = false;

      const s = new StreamingParaformer({
        apiKey,
        workspaceId,
        onResult: (r) =>
          send({
            type: 'result',
            text: r.text,
            sentenceEnd: r.sentenceEnd,
            beginTime: r.beginTime,
            endTime: r.endTime,
          }),
        onDone: () => {
          send({ type: 'done' });
          if (session === s) session = null;
        },
        onError: (err) => {
          console.error('[百炼]', err.message);
          notified = true;
          send({ type: 'error', message: err.message });
          // 会话已不可用，立刻回收，否则后续 start 会被「已有会话」挡住
          if (session === s) {
            session = null;
            s.abort();
          }
        },
      });
      session = s;

      try {
        await s.start(ASR_PARAMS);
        console.log('[会话] 开始');
        send({ type: 'ready' });
      } catch (err) {
        console.error('[会话] 启动失败:', err.message);
        if (!notified) send({ type: 'error', message: err.message });
        s.abort();
        if (session === s) session = null;
      }
      return;
    }

    if (msg.type === 'stop') {
      if (!session) return;
      const s = session;
      session = null;
      try {
        await s.stop();
        console.log('[会话] 结束');
      } catch (err) {
        console.error('[会话] 结束异常:', err.message);
        s.abort();
        send({ type: 'error', message: err.message });
      }
    }
  });

  browser.on('close', () => {
    session?.abort(); // 浏览器关页面时别把百炼连接留在半空
    console.log(`[浏览器] 断开 (剩余 ${wss.clients.size} 个)`);
  });

  browser.on('error', (err) => {
    console.error('[浏览器] 错误:', err.message);
    session?.abort();
  });
});

httpServer.listen(PORT, () => {
  console.log('');
  console.log('  VoicePilot 实时听写 demo');
  console.log('');
  console.log(`  浏览器打开:  http://localhost:${PORT}`);
  console.log('');
  console.log('  按住空格说话（或切到「按一下开始」模式）');
  console.log('  Ctrl+C 停止服务');
  console.log('');
});
