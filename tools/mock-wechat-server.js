/**
 * 假的微信服务端，用于本地联调与自动化验证。
 *
 * 提供两个端点，把收到的客服消息推送写进文件：
 *   GET  /cgi-bin/token                  → 返回假 access_token
 *   POST /cgi-bin/message/custom/send    → 记录推送内容并返回成功
 *
 * 用法：
 *   node tools/mock-wechat-server.js
 * 环境变量：
 *   MOCK_PORT  监听端口，默认 3399
 *   MOCK_LOG   推送记录文件，默认 .dsh-test\mock-pushes.ndjson
 */

import { createServer } from 'node:http';
import { appendFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const PORT = Number(process.env.MOCK_PORT || 3399);
const LOG = resolve(process.env.MOCK_LOG || '.dsh-test/mock-pushes.ndjson');

mkdirSync(dirname(LOG), { recursive: true });
writeFileSync(LOG, '', 'utf8');

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (url.pathname === '/cgi-bin/token') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ access_token: 'MOCK_ACCESS_TOKEN', expires_in: 7200 }));
    console.log('[mock-wechat] 发放 access_token');
    return;
  }

  if (url.pathname === '/cgi-bin/message/custom/send') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let payload = null;
      try { payload = JSON.parse(body); } catch { payload = { raw: body }; }
      const record = { at: new Date().toISOString(), payload };
      appendFileSync(LOG, JSON.stringify(record) + '\n', 'utf8');
      console.log('[mock-wechat] 收到推送 → ' + (payload?.text?.content ?? '').slice(0, 80).replace(/\n/g, ' / '));
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ errcode: 0, errmsg: 'ok' }));
    });
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-wechat] 监听 http://127.0.0.1:${PORT}，推送记录写入 ${LOG}`);
});
