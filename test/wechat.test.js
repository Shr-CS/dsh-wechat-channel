/**
 * dsh-wechat 协议层与路由层测试。
 *
 * 这两层刻意不依赖 Cordis 与 schemastery，所以可以用纯 node:test 直接跑，
 * 不需要启动整个 harness。微信签名是最容易写错的地方，必须钉死。
 *
 * 运行：node --test test/
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

import {
  signatureOf,
  safeEqual,
  verifySignature,
  pickTag,
  cdataSafe,
  parseMessage,
  buildTextReply,
} from '../lib/protocol.js';
import { createHandlers, createRoutes, normalizePath } from '../lib/server.js';

/* ------------------------------ 测试脚手架 ------------------------------ */

const silentLogger = { info() {}, warn() {} };

function fakeReq(method, url, body = '') {
  const req = Readable.from(body === '' ? [] : [Buffer.from(body, 'utf8')]);
  req.method = method;
  req.url = url;
  return req;
}

function fakeRes() {
  return {
    status: 0,
    headers: {},
    body: '',
    headersSent: false,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers ?? {};
      this.headersSent = true;
    },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) this.body += String(chunk);
    },
    destroy() {},
  };
}

const BASE_CONFIG = {
  token: 'dsh_wechat_test_token',
  appId: '',
  appSecret: '',
  path: '/wechat',
  allowFrom: [],
  requireWhitelist: true,
  receipt: '已收到，正在处理…',
  maxBodyBytes: 262144,
};

/** 构造一次合法的微信回调 URL 查询串 */
function signedQuery(token, extra = {}) {
  const timestamp = '1735689600';
  const nonce = 'abc123xyz';
  const signature = signatureOf(token, timestamp, nonce);
  const params = new URLSearchParams({ signature, timestamp, nonce, ...extra });
  return `?${params.toString()}`;
}

/** 造一条微信文本消息 XML */
function textMessageXml({ from = 'oUser_Authorized', to = 'gh_testaccount', content = '你好' } = {}) {
  return [
    '<xml>',
    `<ToUserName><![CDATA[${to}]]></ToUserName>`,
    `<FromUserName><![CDATA[${from}]]></FromUserName>`,
    '<CreateTime>1735689600</CreateTime>',
    '<MsgType><![CDATA[text]]></MsgType>',
    `<Content><![CDATA[${content}]]></Content>`,
    '<MsgId>1234567890123456</MsgId>',
    '</xml>',
  ].join('');
}

/* ============================== 签名算法 ============================== */

describe('签名算法', () => {
  test('是按「值的字典序」排序，而不是参数顺序', () => {
    const token = 'tok';
    // 三组不同的传入顺序，结果必须完全一致
    const a = signatureOf(token, '111', '222');
    const b = signatureOf(token, '222', '111');
    const c = signatureOf(token, '111', '222');
    assert.equal(a, b, '交换 timestamp/nonce 后签名必须不变');
    assert.equal(a, c);
  });

  test('与手工计算的 SHA1 一致', () => {
    const token = 'tok';
    const timestamp = '111';
    const nonce = '222';
    // 手工复现：三个值排序后拼接再 SHA1
    const expected = createHash('sha1').update(['111', '222', 'tok'].sort().join('')).digest('hex');
    assert.equal(signatureOf(token, timestamp, nonce), expected);
    assert.equal(expected.length, 40);
  });

  test('数字与字符串形式的 timestamp 等价', () => {
    assert.equal(signatureOf('t', 123, 'n'), signatureOf('t', '123', 'n'));
  });

  test('safeEqual 对长度不等与空值返回 false，且不抛异常', () => {
    assert.equal(safeEqual('abc', 'abc'), true);
    assert.equal(safeEqual('abc', 'abcd'), false);
    assert.equal(safeEqual('', ''), false);
    assert.equal(safeEqual(undefined, undefined), false);
    assert.equal(safeEqual(null, 'abc'), false);
  });

  test('verifySignature 接受正确签名、拒绝被篡改的签名', () => {
    const token = BASE_CONFIG.token;
    const timestamp = '1735689600';
    const nonce = 'abc123xyz';
    const good = signatureOf(token, timestamp, nonce);

    assert.equal(verifySignature(token, { signature: good, timestamp, nonce }), true);
    assert.equal(verifySignature(token, { signature: good.slice(0, -1) + '0', timestamp, nonce }), false);
    assert.equal(verifySignature(token, { signature: good, timestamp: '1', nonce }), false);
    assert.equal(verifySignature(token, { signature: '', timestamp, nonce }), false);
    assert.equal(verifySignature('', { signature: good, timestamp, nonce }), false);
    assert.equal(verifySignature(token, { signature: good, timestamp: '', nonce }), false);
  });
});

/* ============================== XML 解析 ============================== */

describe('XML 解析与组装', () => {
  test('CDATA 与纯文本两种写法都能取到', () => {
    assert.equal(pickTag('<xml><A><![CDATA[hello]]></A></xml>', 'A'), 'hello');
    assert.equal(pickTag('<xml><A>hello</A></xml>', 'A'), 'hello');
    assert.equal(pickTag('<xml><A></A></xml>', 'A'), '');
    assert.equal(pickTag('<xml></xml>', 'A'), '');
  });

  test('CDATA 里含中文与换行不会丢内容', () => {
    const xml = '<xml><Content><![CDATA[第一行\n第二行 ✓]]></Content></xml>';
    assert.equal(pickTag(xml, 'Content'), '第一行\n第二行 ✓');
  });

  test('parseMessage 解析出完整字段', () => {
    const msg = parseMessage(textMessageXml({ from: 'oABC', content: '帮我看看代码' }));
    assert.equal(msg.from, 'oABC');
    assert.equal(msg.to, 'gh_testaccount');
    assert.equal(msg.msgType, 'text');
    assert.equal(msg.content, '帮我看看代码');
    assert.equal(msg.msgId, '1234567890123456');
  });

  test('cdataSafe 阻断 ]]> 注入', () => {
    assert.equal(cdataSafe('a]]>b'), 'a]] >b');
    // 关键：组装后的 XML 里不能出现会提前闭合 CDATA 的序列
    const xml = buildTextReply('to', 'from', 'x]]>y');
    assert.equal(xml.includes(']]>y'), false);
    assert.equal(pickTag(xml, 'Content'), 'x]] >y');
  });

  test('buildTextReply 结构与微信要求一致', () => {
    const xml = buildTextReply('gh_1', 'oUser', '内容', 1735689600000);
    assert.equal(pickTag(xml, 'ToUserName'), 'gh_1');
    assert.equal(pickTag(xml, 'FromUserName'), 'oUser');
    assert.equal(pickTag(xml, 'MsgType'), 'text');
    assert.equal(pickTag(xml, 'CreateTime'), '1735689600');
    assert.equal(pickTag(xml, 'Content'), '内容');
  });

  test('normalizePath 补上前导斜杠', () => {
    assert.equal(normalizePath('wechat'), '/wechat');
    assert.equal(normalizePath('/wechat'), '/wechat');
    assert.equal(normalizePath('  /hook '), '/hook');
    assert.equal(normalizePath(''), '/wechat');
  });
});

/* ============================== GET 验证 ============================== */

describe('GET 服务器配置验证', () => {
  test('签名正确时原样回显 echostr', async () => {
    const { onVerify } = createHandlers({ config: BASE_CONFIG, logger: silentLogger });
    const req = fakeReq('GET', `/wechat${signedQuery(BASE_CONFIG.token, { echostr: 'ECHO_12345' })}`);
    const res = fakeRes();
    await onVerify(req, res, new URL(req.url, 'http://localhost'));

    assert.equal(res.status, 200);
    assert.equal(res.body, 'ECHO_12345', '必须原样回显，否则微信判定配置失败');
  });

  test('签名错误时返回 403', async () => {
    const { onVerify, stats } = createHandlers({ config: BASE_CONFIG, logger: silentLogger });
    const req = fakeReq('GET', '/wechat?signature=deadbeef&timestamp=1&nonce=2&echostr=x');
    const res = fakeRes();
    await onVerify(req, res, new URL(req.url, 'http://localhost'));

    assert.equal(res.status, 403);
    assert.equal(stats.rejected, 1);
  });

  test('未配置 token 时返回 500 而不是静默通过', async () => {
    const { onVerify } = createHandlers({
      config: { ...BASE_CONFIG, token: '' },
      logger: silentLogger,
    });
    const req = fakeReq('GET', '/wechat?signature=a&timestamp=1&nonce=2&echostr=x');
    const res = fakeRes();
    await onVerify(req, res, new URL(req.url, 'http://localhost'));
    assert.equal(res.status, 500);
  });
});

/* ============================== 白名单 ============================== */

describe('发送者白名单', () => {
  test('未授权的 openid 被拒绝，且回信告知其 openid', async () => {
    const { onMessage, stats } = createHandlers({
      config: { ...BASE_CONFIG, allowFrom: ['oSomeoneElse'] },
      logger: silentLogger,
    });
    const req = fakeReq('POST', `/wechat${signedQuery(BASE_CONFIG.token)}`, textMessageXml({ from: 'oIntruder' }));
    const res = fakeRes();
    await onMessage(req, res, new URL(req.url, 'http://localhost'));

    assert.equal(res.status, 200);
    assert.equal(pickTag(res.body, 'Content').includes('oIntruder'), true);
    assert.equal(stats.messages, 0, '未授权消息不应计入处理量');
    assert.equal(stats.rejected, 1);
  });

  test('白名单为空且强制开启时，所有人都被拒绝（安全默认）', async () => {
    const { onMessage, stats } = createHandlers({ config: BASE_CONFIG, logger: silentLogger });
    const req = fakeReq('POST', `/wechat${signedQuery(BASE_CONFIG.token)}`, textMessageXml());
    const res = fakeRes();
    await onMessage(req, res, new URL(req.url, 'http://localhost'));
    assert.equal(stats.messages, 0);
  });

  test('授权 openid 可以正常下指令', async () => {
    const seen = [];
    const { onMessage, stats } = createHandlers({
      config: { ...BASE_CONFIG, allowFrom: ['oUser_Authorized'] },
      logger: silentLogger,
      handleMessage: async (msg) => {
        seen.push(msg);
        return `已处理：${msg.content}`;
      },
    });
    const req = fakeReq('POST', `/wechat${signedQuery(BASE_CONFIG.token)}`, textMessageXml({ content: '列出文件' }));
    const res = fakeRes();
    await onMessage(req, res, new URL(req.url, 'http://localhost'));

    assert.equal(seen.length, 1);
    assert.equal(seen[0].content, '列出文件');
    assert.equal(pickTag(res.body, 'Content'), '已处理：列出文件');
    assert.equal(stats.messages, 1);
  });
});

/* ============================== 响应契约 ============================== */

describe('5 秒死线与异步回复契约', () => {
  test('handleMessage 返回 null 时只回 success，不占用被动回复', async () => {
    const { onMessage } = createHandlers({
      config: { ...BASE_CONFIG, allowFrom: ['oUser_Authorized'] },
      logger: silentLogger,
      handleMessage: async () => null,
    });
    const req = fakeReq('POST', `/wechat${signedQuery(BASE_CONFIG.token)}`, textMessageXml());
    const res = fakeRes();
    await onMessage(req, res, new URL(req.url, 'http://localhost'));
    assert.equal(res.body, 'success');
  });

  test('handleMessage 超时不会拖垮响应，改发回执并计数', async () => {
    const { onMessage, stats } = createHandlers({
      config: { ...BASE_CONFIG, allowFrom: ['oUser_Authorized'] },
      logger: silentLogger,
      handleMessage: () => new Promise(() => {}), // 永不 resolve，模拟 agent 跑很久
      deadlineMs: 40,
    });
    const req = fakeReq('POST', `/wechat${signedQuery(BASE_CONFIG.token)}`, textMessageXml());
    const res = fakeRes();

    const began = Date.now();
    await onMessage(req, res, new URL(req.url, 'http://localhost'));
    const elapsed = Date.now() - began;

    assert.equal(res.status, 200);
    assert.equal(pickTag(res.body, 'Content'), BASE_CONFIG.receipt);
    assert.equal(stats.timeouts, 1);
    assert.ok(elapsed < 2000, `必须在死线附近返回，实际 ${elapsed}ms`);
  });

  test('handleMessage 抛异常时回一条错误信息而不是 500', async () => {
    const { onMessage } = createHandlers({
      config: { ...BASE_CONFIG, allowFrom: ['oUser_Authorized'] },
      logger: silentLogger,
      handleMessage: async () => {
        throw new Error('模拟失败');
      },
    });
    const req = fakeReq('POST', `/wechat${signedQuery(BASE_CONFIG.token)}`, textMessageXml());
    const res = fakeRes();
    await onMessage(req, res, new URL(req.url, 'http://localhost'));
    assert.equal(res.status, 200);
    assert.equal(pickTag(res.body, 'Content').includes('模拟失败'), true);
  });

  test('关注事件回欢迎语并带出 openid', async () => {
    const { onMessage } = createHandlers({ config: BASE_CONFIG, logger: silentLogger });
    const xml = [
      '<xml><ToUserName><![CDATA[gh_1]]></ToUserName>',
      '<FromUserName><![CDATA[oNewFollower]]></FromUserName>',
      '<CreateTime>1</CreateTime><MsgType><![CDATA[event]]></MsgType>',
      '<Event><![CDATA[subscribe]]></Event></xml>',
    ].join('');
    const req = fakeReq('POST', `/wechat${signedQuery(BASE_CONFIG.token)}`, xml);
    const res = fakeRes();
    await onMessage(req, res, new URL(req.url, 'http://localhost'));
    assert.equal(pickTag(res.body, 'Content').includes('oNewFollower'), true);
  });
});

/* ============================== 自检端点 ============================== */

describe('状态端点', () => {
  test('口令错误返回 403', async () => {
    const { onStatus } = createHandlers({ config: BASE_CONFIG, logger: silentLogger });
    const req = fakeReq('GET', '/wechat/status?key=wrong');
    const res = fakeRes();
    await onStatus(req, res, new URL(req.url, 'http://localhost'));
    assert.equal(res.status, 403);
  });

  test('口令正确返回 JSON，且不泄漏 token 本身', async () => {
    const { onStatus } = createHandlers({ config: BASE_CONFIG, logger: silentLogger });
    const req = fakeReq('GET', `/wechat/status?key=${BASE_CONFIG.token}`);
    const res = fakeRes();
    await onStatus(req, res, new URL(req.url, 'http://localhost'));

    assert.equal(res.status, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.plugin, 'dsh-wechat-channel');
    assert.equal(payload.configured.token, true);
    assert.equal(res.body.includes(BASE_CONFIG.token), false, '状态页绝不能回显 token');
  });
});

/* ============================== 路由形状 ============================== */

describe('路由注册形状', () => {
  test('createRoutes 产出 webServer.register 需要的字段', () => {
    const { routes, handlers } = createRoutes({ config: BASE_CONFIG, logger: silentLogger });
    assert.equal(routes.length, 2);
    for (const route of routes) {
      assert.ok(route.kind === 'exact', '必须是 exact，避免前缀吞掉其它路由');
      assert.equal(typeof route.path, 'string');
      assert.equal(typeof route.handler, 'function');
    }
    assert.equal(routes[0].path, '/wechat');
    assert.equal(routes[1].path, '/wechat/status');
    assert.equal(handlers.path, '/wechat');
  });

  test('非 GET/POST 返回 405', async () => {
    const { routes } = createRoutes({ config: BASE_CONFIG, logger: silentLogger });
    const req = fakeReq('DELETE', '/wechat');
    const res = fakeRes();
    await routes[0].handler(req, res);
    assert.equal(res.status, 405);
  });
});
