/**
 * 微信服务端 API 客户端测试。
 *
 * 用注入的假 fetch 完整覆盖 token 缓存、并发去重、失效刷新重试、
 * 长文本分条与各类失败路径 —— 这些都不需要真的微信账号。
 *
 * 运行：node --test test/wechat-api.test.js
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createWeChatApi, chunkText, MAX_TEXT_BYTES } from '../lib/wechat-api.js';

/* ------------------------------ 假 fetch ------------------------------ */

function makeResponse(payload, status = 200) {
  return {
    status,
    text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
  };
}

/**
 * 按 URL 子串路由的假 fetch。
 * routes: [[子串, (url, init) => payload | {__status, __body}]]
 */
function mockFetch(routes) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : null });
    for (const [fragment, handler] of routes) {
      if (url.includes(fragment)) {
        const result = await handler(url, init);
        if (result && result.__status) return makeResponse(result.__body, result.__status);
        return makeResponse(result);
      }
    }
    throw new Error('未 mock 的请求: ' + url);
  };
  return { calls, impl };
}

const CREDS = { appId: 'wx_test_app', appSecret: 'secret_value' };
const silent = { info() {}, warn() {} };

function makeApi(routes, extra = {}) {
  const mock = mockFetch(routes);
  const api = createWeChatApi({
    ...CREDS,
    logger: silent,
    fetchImpl: mock.impl,
    ...extra,
  });
  return { api, mock };
}

/* ============================== 分条逻辑 ============================== */

describe('chunkText 分条', () => {
  test('短文本原样返回一条', () => {
    assert.deepEqual(chunkText('你好'), ['你好']);
  });

  test('空值与 null 安全', () => {
    assert.deepEqual(chunkText(''), ['']);
    assert.deepEqual(chunkText(null), ['']);
    assert.deepEqual(chunkText(undefined), ['']);
  });

  test('按 UTF-8 字节切分，中文一个字 3 字节', () => {
    // 700 个汉字 = 2100 字节 > 1900 上限，必须切成两条
    const text = '汉'.repeat(700);
    const chunks = chunkText(text);
    assert.ok(chunks.length >= 2, `应当分成多条，实际 ${chunks.length}`);
    for (const chunk of chunks) {
      assert.ok(Buffer.byteLength(chunk, 'utf8') <= MAX_TEXT_BYTES,
        `分条后仍超限：${Buffer.byteLength(chunk, 'utf8')} 字节`);
    }
    assert.equal(chunks.join(''), text, '拼回来必须与原文一致，不能丢字');
  });

  test('优先在换行处断开', () => {
    const line = 'x'.repeat(1000);
    const text = `${line}\n${line}\n${line}`;
    const chunks = chunkText(text);
    assert.ok(chunks.length >= 2);
    assert.equal(chunks.join('\n'), text);
  });

  test('单行超长也能硬切且不丢内容', () => {
    const text = 'a'.repeat(5000);
    const chunks = chunkText(text);
    assert.ok(chunks.length >= 3);
    assert.equal(chunks.join(''), text);
  });
});

/* ============================== access_token ============================== */

describe('access_token 管理', () => {
  test('第一次取 token 会请求接口，之后走缓存', async () => {
    let tokenHits = 0;
    const { api, mock } = makeApi([
      ['/cgi-bin/token', () => { tokenHits += 1; return { access_token: 'T1', expires_in: 7200 }; }],
      ['/message/custom/send', () => ({ errcode: 0, errmsg: 'ok' })],
    ]);

    const a = await api.getAccessToken();
    const b = await api.getAccessToken();
    assert.equal(a, 'T1');
    assert.equal(b, 'T1');
    assert.equal(tokenHits, 1, '第二次必须走缓存，不能重复请求');

    await api.sendText('oUser', 'hi');
    await api.sendText('oUser', 'hi again');
    assert.equal(tokenHits, 1, '发消息也不应重新取 token');
    assert.equal(mock.calls.filter((c) => c.url.includes('/message/custom/send')).length, 2);
  });

  test('并发取 token 只发一次请求（去重）', async () => {
    let tokenHits = 0;
    const { api } = makeApi([
      ['/cgi-bin/token', async () => {
        tokenHits += 1;
        await new Promise((r) => setTimeout(r, 30));
        return { access_token: 'T2', expires_in: 7200 };
      }],
    ]);

    const results = await Promise.all([api.getAccessToken(), api.getAccessToken(), api.getAccessToken()]);
    assert.deepEqual(results, ['T2', 'T2', 'T2']);
    assert.equal(tokenHits, 1, '并发场景必须去重，否则会打爆接口');
  });

  test('过期后自动重新取', async () => {
    let tokenHits = 0;
    let clock = 1_000_000;
    const { api } = makeApi([
      ['/cgi-bin/token', () => { tokenHits += 1; return { access_token: `T${tokenHits}`, expires_in: 7200 }; }],
    ], { now: () => clock });

    assert.equal(await api.getAccessToken(), 'T1');
    assert.equal(api.tokenCached, true);

    // 提前 300 秒过期：有效期 7200 - 300 = 6900 秒
    clock += 6901 * 1000;
    assert.equal(api.tokenCached, false);
    assert.equal(await api.getAccessToken(), 'T2');
    assert.equal(tokenHits, 2);
  });

  test('接口返回 errcode 时抛出可读错误', async () => {
    const { api } = makeApi([
      ['/cgi-bin/token', () => ({ errcode: 40164, errmsg: 'invalid ip' })],
    ]);
    await assert.rejects(() => api.getAccessToken(), /40164.*invalid ip/);
  });

  test('返回非 JSON 时给出可读错误而不是崩在 JSON.parse', async () => {
    const { api } = makeApi([
      ['/cgi-bin/token', () => ({ __status: 502, __body: '<html>bad gateway</html>' })],
    ]);
    await assert.rejects(() => api.getAccessToken(), /不是 JSON/);
  });
});

/* ============================== 发消息 ============================== */

describe('客服消息发送', () => {
  test('发送成功返回 ok 与条数', async () => {
    const { api, mock } = makeApi([
      ['/cgi-bin/token', () => ({ access_token: 'T', expires_in: 7200 })],
      ['/message/custom/send', () => ({ errcode: 0, errmsg: 'ok' })],
    ]);

    const result = await api.sendText('oUser', '任务已完成');
    assert.equal(result.ok, true);
    assert.equal(result.sent, 1);

    const send = mock.calls.find((c) => c.url.includes('/message/custom/send'));
    assert.equal(send.body.touser, 'oUser');
    assert.equal(send.body.msgtype, 'text');
    assert.equal(send.body.text.content, '任务已完成');
  });

  test('token 失效（40001）会刷新后重试一次并成功', async () => {
    let tokenHits = 0;
    let sendHits = 0;
    const { api } = makeApi([
      ['/cgi-bin/token', () => { tokenHits += 1; return { access_token: `T${tokenHits}`, expires_in: 7200 }; }],
      ['/message/custom/send', () => {
        sendHits += 1;
        // 第一次用旧 token 失败，刷新后第二次成功
        if (sendHits === 1) return { errcode: 40001, errmsg: 'invalid credential' };
        return { errcode: 0, errmsg: 'ok' };
      }],
    ]);

    const result = await api.sendText('oUser', 'hi');
    assert.equal(result.ok, true);
    assert.equal(sendHits, 2, '应当重试一次');
    assert.equal(tokenHits, 2, '重试前必须强制刷新 token');
  });

  test('重试后仍失败则如实返回错误，不无限重试', async () => {
    let sendHits = 0;
    const { api } = makeApi([
      ['/cgi-bin/token', () => ({ access_token: 'T', expires_in: 7200 })],
      ['/message/custom/send', () => { sendHits += 1; return { errcode: 40001, errmsg: 'invalid credential' }; }],
    ]);

    const result = await api.sendText('oUser', 'hi');
    assert.equal(result.ok, false);
    assert.match(result.error, /40001/);
    assert.equal(sendHits, 2, '只应重试一次，避免死循环');
  });

  test('非 token 类错误不重试', async () => {
    let sendHits = 0;
    const { api } = makeApi([
      ['/cgi-bin/token', () => ({ access_token: 'T', expires_in: 7200 })],
      ['/message/custom/send', () => { sendHits += 1; return { errcode: 48001, errmsg: 'api unauthorized' }; }],
    ]);

    const result = await api.sendText('oUser', 'hi');
    assert.equal(result.ok, false);
    assert.equal(sendHits, 1, '48001 不是 token 问题，不该重试');
  });

  test('超长回复自动分多条发送', async () => {
    const { api, mock } = makeApi([
      ['/cgi-bin/token', () => ({ access_token: 'T', expires_in: 7200 })],
      ['/message/custom/send', () => ({ errcode: 0, errmsg: 'ok' })],
    ]);

    const long = '这是一段很长的回复。'.repeat(300); // 约 3000 汉字 ≈ 9000 字节
    const result = await api.sendText('oUser', long);
    assert.equal(result.ok, true);
    assert.ok(result.sent >= 4, `应当分多条，实际 ${result.sent}`);

    const sends = mock.calls.filter((c) => c.url.includes('/message/custom/send'));
    assert.equal(sends.length, result.sent);
    assert.equal(sends.map((c) => c.body.text.content).join(''), long, '拼回来必须完整');
  });

  test('分条中途失败会如实报告已发条数', async () => {
    let sendHits = 0;
    const { api } = makeApi([
      ['/cgi-bin/token', () => ({ access_token: 'T', expires_in: 7200 })],
      ['/message/custom/send', () => {
        sendHits += 1;
        return sendHits <= 1 ? { errcode: 0, errmsg: 'ok' } : { errcode: 45015, errmsg: 'response out of time limit' };
      }],
    ]);

    const result = await api.sendText('oUser', '很长的内容。'.repeat(400));
    assert.equal(result.ok, false);
    assert.equal(result.sent, 1);
    assert.match(result.error, /45015/);
  });

  test('网络异常被捕获成 ok:false，不会抛出', async () => {
    const api = createWeChatApi({
      ...CREDS,
      logger: silent,
      fetchImpl: async () => { throw new Error('ENOTFOUND api.weixin.qq.com'); },
    });
    const result = await api.sendText('oUser', 'hi');
    assert.equal(result.ok, false);
    assert.match(result.error, /ENOTFOUND/);
  });
});

/* ============================== 未配置 ============================== */

describe('未配置凭据时', () => {
  test('configured 为 false，发送返回可读错误而不是抛异常', async () => {
    const api = createWeChatApi({ appId: '', appSecret: '', logger: silent });
    assert.equal(api.configured, false);
    const result = await api.sendText('oUser', 'hi');
    assert.equal(result.ok, false);
    assert.match(result.error, /未配置/);
  });

  test('只给了 appId 也算未配置', () => {
    const api = createWeChatApi({ appId: 'wx_x', appSecret: '', logger: silent });
    assert.equal(api.configured, false);
  });
});
