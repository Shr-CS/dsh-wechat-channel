/**
 * 集成测试：把 lib/index.js（真正的 Cordis 插件入口）装进一个假的 ctx，
 * 配一个真的 node:http 服务器，用真的 HTTP 请求打进去。
 *
 * 为什么值得单独做这一层：
 *   单元测试只覆盖了 protocol.js / server.js。而真正会在 DSH 里跑的入口是
 *   index.js —— 它负责 Config 默认值、路由注册形状、effect 清理。
 *   这一层如果有问题，装进 profile 就是「DSH 起不来」。
 *   所以在动用户的 profile 之前，先把这条链路用真 HTTP 跑通。
 *
 * 运行：node --test test/integration.test.js
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { signatureOf } from '../lib/protocol.js';
import plugin from '../lib/index.js';

// 谐音别名：原先是 schemastery 的 Config，现在换成本插件自己手写的规整函数，
// 调用点形状一致，因此下面所有 Config({...}) 都无需改动。
const { name, inject, normalizeConfig: Config, apply } = plugin;

/* ------------------------------ 假 ctx ------------------------------ */

function makeFakeCtx() {
  const routes = [];
  const effects = [];
  const logs = [];
  const injected = [];

  /** 假的会话运行时服务，形状对齐真实 ctx 的相关服务 */
  const agentCtx = {
    agents: {
      // 模拟真实行为：会话已存在时 create 会拒绝，必须靠 resume 复用
      async resume() {
        throw new Error('no persisted session in fake ctx');
      },
      async create(options) {
        // 会话日志像真实那样随 followup 增长 —— bridge 靠它判断驱动器是否启动
        const messages = [{ role: 'user', content: [{ type: 'text', text: '（初始）' }] }];
        const agent = {
          followup() {
            messages.push({ role: 'assistant', content: [{ type: 'text', text: '这是来自假 agent 的回复' }] });
          },
          async whenIdle() {},
          cancel() {},
          session: {
            requestHeader: () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
            deriveMessages: () => messages.slice(),
          },
        };
        if (options && typeof options.setup === 'function') {
          await options.setup({ on() {}, agent });
        }
        return { agent, async dispose() {} };
      },
    },
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
    },
    workspaceRegistry: {
      async create(p) {
        return { path: p || '/fake/workspace', async attachSession() {}, async detachSession() {} };
      },
    },
    agentPresets: { async resolve(id) { return { id }; }, async mount() {} },
    permissionPresets: { set() {} },
    /** 无持久化后端：list() 返回空 → 走新建分支 */
    get(name) {
      if (name === 'sessionPersistence') return { async list() { return []; } };
      return undefined;
    },
  };

  return {
    routes,
    effects,
    logs,
    injected,
    agentCtx,
    logger: {
      info: (m) => logs.push({ level: 'info', message: String(m) }),
      warn: (m) => logs.push({ level: 'warn', message: String(m) }),
    },
    webServer: {
      port: 0,
      register(route) {
        if (routes.some((r) => r.kind === route.kind && r.path === route.path)) {
          throw new Error(`duplicate ${route.kind} route "${route.path}"`);
        }
        routes.push(route);
        return () => {
          const at = routes.indexOf(route);
          if (at !== -1) routes.splice(at, 1);
        };
      },
    },
    inject(services, callback) {
      injected.push(services);
      callback(agentCtx);
    },
    effect(fn, label) {
      const dispose = fn();
      effects.push({ dispose, label });
      return () => {};
    },
  };
}

/** 起一个真 HTTP 服务器，按 webserver 的匹配规则分发（精确优先） */
function startServer(ctx) {
  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://x').pathname;
    const route = ctx.routes.find((r) => r.kind === 'exact' && r.path === pathname);
    if (!route) {
      res.writeHead(404);
      res.end();
      return;
    }
    Promise.resolve(route.handler(req, res)).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500);
        res.end();
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const TOKEN = 'dshwechat_9f3a7c1e4b2d6a80';
const OPENID = 'oUser_Authorized';

function signed(path, token = TOKEN, extra = {}) {
  const timestamp = '1735689600';
  const nonce = 'abc123xyz';
  const params = new URLSearchParams({
    signature: signatureOf(token, timestamp, nonce),
    timestamp,
    nonce,
    ...extra,
  });
  return `${path}?${params.toString()}`;
}

function textXml(content = '你好') {
  return [
    '<xml>',
    '<ToUserName><![CDATA[gh_test]]></ToUserName>',
    `<FromUserName><![CDATA[${OPENID}]]></FromUserName>`,
    '<CreateTime>1735689600</CreateTime>',
    '<MsgType><![CDATA[text]]></MsgType>',
    `<Content><![CDATA[${content}]]></Content>`,
    '<MsgId>1</MsgId>',
    '</xml>',
  ].join('');
}

/* ============================== 测试 ============================== */

describe('插件入口契约', () => {
  test('导出 Cordis 需要的四个字段', () => {
    assert.equal(name, 'dsh-wechat');
    assert.deepEqual(inject, ['webServer']);
    assert.equal(typeof apply, 'function');
    assert.equal(typeof Config, 'function', 'Config（normalizeConfig）应当是函数');
  });

  test('Config 会补全默认值，并保留调用方给出的值', () => {
    const resolved = Config({ token: TOKEN, allowFrom: [OPENID] });
    assert.equal(resolved.token, TOKEN);
    assert.deepEqual(resolved.allowFrom, [OPENID]);
    // 默认路径刻意不是 /wechat：npm 上的第三方包 dsh-wechat 注册了 /wechat/status，
    // 而 DSH 的 webserver 对重复路由直接抛错，会让本插件整个激活失败。
    assert.equal(resolved.path, '/wechat-mp', 'path 应回落到 /wechat-mp（避开与第三方包的路由冲突）');
    assert.equal(resolved.requireWhitelist, true, '白名单默认必须开启');
    assert.equal(resolved.maxBodyBytes, 262144);
  });
});

describe('整链路（真 HTTP）', () => {
  let ctx;
  let server;
  let base;
  let wechatMock;
  const pushes = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  before(async () => {
    // 假的微信服务端：提供 token 与客服消息两个端点，并记录所有推送
    wechatMock = createServer((req, res) => {
      const pathname = new URL(req.url ?? '/', 'http://x').pathname;
      if (pathname === '/cgi-bin/token') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ access_token: 'MOCK_TOKEN', expires_in: 7200 }));
        return;
      }
      if (pathname === '/cgi-bin/message/custom/send') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          pushes.push(JSON.parse(body));
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ errcode: 0, errmsg: 'ok' }));
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise((r) => wechatMock.listen(0, '127.0.0.1', r));
    const wechatBase = `http://127.0.0.1:${wechatMock.address().port}`;

    ctx = makeFakeCtx();
    apply(ctx, Config({
      // 显式指定路径，让这些用例与默认值解耦
      path: '/wechat',
      token: TOKEN,
      allowFrom: [OPENID],
      appId: 'wx_mock_app',
      appSecret: 'mock_secret',
      apiBaseUrl: wechatBase,
    }));
    server = await startServer(ctx);
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (server) await new Promise((r) => server.close(r));
    if (wechatMock) await new Promise((r) => wechatMock.close(r));
    for (const { dispose } of ctx.effects) if (typeof dispose === 'function') dispose();
  });

  test('apply 注册了两条精确路由', () => {
    const paths = ctx.routes.map((r) => r.path).sort();
    assert.deepEqual(paths, ['/wechat', '/wechat/status']);
    assert.ok(ctx.routes.every((r) => r.kind === 'exact'));
  });

  test('GET 验证：签名正确时原样回显 echostr', async () => {
    const res = await fetch(`${base}${signed('/wechat', TOKEN, { echostr: 'ECHO_98765' })}`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'ECHO_98765');
  });

  test('GET 验证：Token 不一致时返回 403（模拟后台填错 Token）', async () => {
    const res = await fetch(`${base}${signed('/wechat', 'wrong_token', { echostr: 'x' })}`);
    assert.equal(res.status, 403);
  });

  test('POST 授权用户：被动回复上一条文本消息', async () => {
    const res = await fetch(`${base}${signed('/wechat')}`, {
      method: 'POST',
      headers: { 'content-type': 'text/xml' },
      body: textXml('列出当前目录'),
    });
    const body = await res.text();
    assert.equal(res.status, 200);
    assert.match(body, /<MsgType><!\[CDATA\[text\]\]><\/MsgType>/);
    assert.match(body, /已收到/);
    assert.match(body, new RegExp(`<ToUserName><!\\[CDATA\\[${OPENID}\\]\\]></ToUserName>`));
    assert.match(body, /完成后我会主动把结果发给你/, '应告知用户结果会异步推送');
  });

  test('软依赖注入被请求了会话运行时所需的服务', () => {
    const services = ctx.injected.flat();
    for (const needed of ['agents', 'workspaceRegistry', 'agentPresets', 'permissionPresets', 'agentDefaultModel']) {
      assert.ok(services.includes(needed), `应当注入 ${needed}`);
    }
  });

  /** 等后台推送全部落地：避免上一条用例的异步推送串进本条用例 */
  async function drainPushes() {
    let stable = 0;
    let last = pushes.length;
    for (let i = 0; i < 40 && stable < 3; i++) {
      await sleep(40);
      if (pushes.length === last) stable += 1;
      else { stable = 0; last = pushes.length; }
    }
  }

  test('【核心】完整异步链路：微信消息 → 立刻回执 → 后台跑 DSH → 客服消息推回结果', async () => {
    await drainPushes();
    pushes.length = 0;

    const began = Date.now();
    const res = await fetch(`${base}${signed('/wechat')}`, {
      method: 'POST',
      body: textXml('帮我看看这个项目'),
    });
    const body = await res.text();
    const receiptMs = Date.now() - began;

    assert.equal(res.status, 200);
    assert.match(body, /已收到/, '必须先回执，不能等 DSH 跑完');
    assert.ok(receiptMs < 2000, `回执必须远快于微信 5 秒限制，实际 ${receiptMs}ms`);

    // 等后台把结果推回来
    for (let i = 0; i < 80 && pushes.length === 0; i++) await sleep(25);

    assert.equal(pushes.length, 1, `应当恰好推送一条客服消息，实际 ${pushes.length}`);
    assert.equal(pushes[0].touser, OPENID);
    assert.equal(pushes[0].msgtype, 'text');
    assert.match(pushes[0].text.content, /这是来自假 agent 的回复/,
      '推送内容必须是 DSH 的真实回复，而不是占位话术');
  });

  test('非文本消息给出可读提示，而不是硬走会话', async () => {
    const xml = [
      '<xml><ToUserName><![CDATA[gh_test]]></ToUserName>',
      `<FromUserName><![CDATA[${OPENID}]]></FromUserName>`,
      '<CreateTime>1</CreateTime><MsgType><![CDATA[image]]></MsgType>',
      '<PicUrl><![CDATA[http://x/y.jpg]]></PicUrl></xml>',
    ].join('');
    const res = await fetch(`${base}${signed('/wechat')}`, { method: 'POST', body: xml });
    const body = await res.text();
    assert.match(body, /只支持文本消息/);
    assert.match(body, /image/);
  });

  test('空文本消息被挡下', async () => {
    const res = await fetch(`${base}${signed('/wechat')}`, {
      method: 'POST',
      body: textXml('   '),
    });
    assert.match(await res.text(), /消息内容为空/);
  });

  test('POST 未授权 openid：回信里带出他的 openid 供加入白名单', async () => {
    const xml = textXml('试探').replaceAll(OPENID, 'oStranger');
    const res = await fetch(`${base}${signed('/wechat')}`, {
      method: 'POST',
      body: xml,
    });
    const body = await res.text();
    assert.match(body, /oStranger/);
    assert.match(body, /未授权/);
  });

  test('中文与 emoji 内容不会在回复里乱码', async () => {
    const res = await fetch(`${base}${signed('/wechat')}`, {
      method: 'POST',
      body: textXml('帮我看看这份代码 ✓'),
    });
    const body = await res.text();
    assert.equal(body.includes('\uFFFD'), false, '不应出现替换字符');
    assert.match(body, /已收到/);
  });

  test('状态端点：口令正确返回 JSON', async () => {
    const res = await fetch(`${base}/wechat/status?key=${TOKEN}`);
    assert.equal(res.status, 200);
    const payload = await res.json();
    assert.equal(payload.plugin, 'dsh-wechat');
    assert.equal(payload.stats.messages >= 1, true);
  });

  test('状态端点：口令错误 403', async () => {
    const res = await fetch(`${base}/wechat/status?key=nope`);
    assert.equal(res.status, 403);
  });

  test('未注册路径返回 404，不会误吞其它路由', async () => {
    const res = await fetch(`${base}/api/something`);
    assert.equal(res.status, 404);
  });

  test('会记录验证通过的日志，便于在 DSH 里确认', () => {
    const found = ctx.logs.some(
      (l) => l.level === 'info' && l.message.includes('验证通过'),
    );
    assert.equal(found, true, `日志里应出现「验证通过」，实际：${JSON.stringify(ctx.logs.slice(-4))}`);
  });
});

describe('缺陷配置下的行为', () => {
  test('未配置 token 时 apply 只警告、不抛异常（DSH 仍能启动）', () => {
    const ctx = makeFakeCtx();
    assert.doesNotThrow(() => apply(ctx, Config({})));
    const warned = ctx.logs.some((l) => l.level === 'warn' && l.message.includes('token'));
    assert.equal(warned, true, '必须警告，否则用户不知道为什么不工作');
    assert.equal(ctx.routes.length, 2, '路由仍应挂上，只是会拒绝请求');
  });

  test('effect 的 disposer 能摘掉路由', () => {
    const ctx = makeFakeCtx();
    apply(ctx, Config({ token: TOKEN }));
    assert.equal(ctx.routes.length, 2);
    for (const { dispose } of ctx.effects) if (typeof dispose === 'function') dispose();
    assert.equal(ctx.routes.length, 0, '释放后不应残留路由，否则重载会撞重复路径');
  });
});
