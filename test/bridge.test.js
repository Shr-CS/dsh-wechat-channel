/**
 * 桥接层测试：会话生命周期、每用户串行、超时、错误路径。
 * 用假 agent 驱动，不需要真实 DSH 运行时。
 *
 * 运行：node --test test/bridge.test.js
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createBridge, extractAssistantText, formatForWeChat } from '../lib/bridge.js';

const silent = { info() {}, warn() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 造一个符合 DSH Agent 形状的假对象 */
function makeFakeAgent({ reply = '这是回复', whenIdleMs = 0, followupThrows = false, shared = null } = {}) {
  const state = { inflight: 0, maxInflight: 0 };
  // 模拟真实的会话日志：followup 之后日志才会变长，
  // 这正是 bridge 判断「驱动器是否真的启动」的依据
  const messages = [{ role: 'user', content: [{ type: 'text', text: '问题' }] }];
  const agent = {
    followups: [],
    disposed: false,
    cancelled: null,
    state,
    followup(message) {
      if (followupThrows) throw new Error('followup 失败');
      this.followups.push(message);
      messages.push({ role: 'assistant', content: [{ type: 'text', text: reply }] });
      state.inflight += 1;
      state.maxInflight = Math.max(state.maxInflight, state.inflight);
      if (shared) {
        shared.inflight += 1;
        shared.maxInflight = Math.max(shared.maxInflight, shared.inflight);
      }
    },
    async whenIdle() {
      if (whenIdleMs) await sleep(whenIdleMs);
      state.inflight -= 1;
      if (shared) shared.inflight -= 1;
    },
    session: {
      deriveMessages: () => messages.slice(),
    },
    cancel(cause) { this.cancelled = cause; },
    async dispose() { this.disposed = true; },
  };
  return agent;
}

/* ============================== 文本提取 ============================== */

describe('extractAssistantText', () => {
  test('取最后一条助手消息的文本', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: '问' }] },
      { role: 'assistant', content: [{ type: 'text', text: '第一次回答' }] },
      { role: 'user', content: [{ type: 'text', text: '再问' }] },
      { role: 'assistant', content: [{ type: 'text', text: '第二次回答' }] },
    ];
    assert.equal(extractAssistantText(messages), '第二次回答');
  });

  test('多个文本块用换行拼接', () => {
    const messages = [{ role: 'assistant', content: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }] }];
    assert.equal(extractAssistantText(messages), 'A\nB');
  });

  test('跳过非文本块（工具调用等）', () => {
    const messages = [{
      role: 'assistant',
      content: [{ type: 'tool_call', name: 'x' }, { type: 'text', text: '只有这段是文本' }],
    }];
    assert.equal(extractAssistantText(messages), '只有这段是文本');
  });

  test('没有助手消息时返回空串', () => {
    assert.equal(extractAssistantText([]), '');
    assert.equal(extractAssistantText([{ role: 'user', content: [{ type: 'text', text: 'x' }] }]), '');
    assert.equal(extractAssistantText(null), '');
  });

  test('助手消息文本为空白时继续往前找', () => {
    const messages = [
      { role: 'assistant', content: [{ type: 'text', text: '有内容' }] },
      { role: 'assistant', content: [{ type: 'text', text: '   ' }] },
    ];
    assert.equal(extractAssistantText(messages), '有内容');
  });
});

/* ============================== 微信排版 ============================== */

describe('formatForWeChat', () => {
  test('空回复给出友好兜底文案', () => {
    assert.match(formatForWeChat(''), /没有返回文本/);
    assert.match(formatForWeChat('   '), /没有返回文本/);
  });

  test('Markdown 表格被拉平成可读文本（微信不渲染表格）', () => {
    const md = '| 姓名 | 年龄 |\n|---|---|\n| 张三 | 20 |';
    const out = formatForWeChat(md);
    assert.equal(out.includes('|'), false, '不应残留竖线');
    assert.match(out, /姓名 · 年龄/);
    assert.match(out, /张三 · 20/);
  });

  test('标题井号被去掉', () => {
    assert.equal(formatForWeChat('## 结论\n内容'), '结论\n内容');
  });

  test('超长内容截断并提示', () => {
    const out = formatForWeChat('字'.repeat(5000), { maxChars: 100 });
    assert.ok(out.length < 200);
    assert.match(out, /已截断/);
  });
});

/* ============================== 会话生命周期 ============================== */

describe('会话生命周期', () => {
  test('同一用户复用同一个 agent，不会反复创建', async () => {
    let created = 0;
    const agents = [];
    const bridge = createBridge({
      logger: silent,
      createAgent: async () => { created += 1; const a = makeFakeAgent(); agents.push(a); return a; },
    });

    await bridge.ask('oUserA', '第一条');
    await bridge.ask('oUserA', '第二条');

    assert.equal(created, 1, '同一用户只应创建一个会话');
    assert.equal(agents[0].followups.length, 2, '两次提问都要投进同一个 agent');
    assert.equal(agents[0].followups[0].content[0].text, '第一条');
  });

  test('不同用户各自独立会话', async () => {
    let created = 0;
    const bridge = createBridge({
      logger: silent,
      createAgent: async () => { created += 1; return makeFakeAgent(); },
    });
    await bridge.ask('oUserA', 'x');
    await bridge.ask('oUserB', 'y');
    assert.equal(created, 2);
    assert.equal(bridge.sessionCount, 2);
  });

  test('回复内容正确回传', async () => {
    const bridge = createBridge({
      logger: silent,
      createAgent: async () => makeFakeAgent({ reply: '任务已经完成了 ✓' }),
    });
    const result = await bridge.ask('oUser', '帮我做点事');
    assert.equal(result.ok, true);
    assert.equal(result.reply, '任务已经完成了 ✓');
    assert.equal(typeof result.elapsedMs, 'number');
  });

  test('disposeAll 释放所有会话', async () => {
    const agents = [];
    const bridge = createBridge({
      logger: silent,
      createAgent: async () => { const a = makeFakeAgent(); agents.push(a); return a; },
    });
    await bridge.ask('oA', 'x');
    await bridge.ask('oB', 'y');
    await bridge.disposeAll();
    assert.equal(agents.every((a) => a.disposed), true);
    assert.equal(bridge.sessionCount, 0);
  });
});

/* ============================== 并发与串行 ============================== */

describe('并发控制', () => {
  test('同一用户连发两条消息会串行执行，不并发操作同一会话', async () => {
    const shared = { inflight: 0, maxInflight: 0 };
    let created = 0;
    const bridge = createBridge({
      logger: silent,
      createAgent: async () => { created += 1; return makeFakeAgent({ whenIdleMs: 60, shared }); },
    });

    const [r1, r2] = await Promise.all([
      bridge.ask('oUser', '第一条'),
      bridge.ask('oUser', '第二条'),
    ]);

    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);
    assert.equal(created, 1, '并发提问也应复用同一会话');
    assert.equal(shared.maxInflight, 1, `同一会话不应并发进入，实际峰值 ${shared.maxInflight}`);
  });

  test('不同用户可以并行，互不阻塞', async () => {
    let created = 0;
    const bridge = createBridge({
      logger: silent,
      createAgent: async () => { created += 1; return makeFakeAgent({ whenIdleMs: 80 }); },
    });

    const began = Date.now();
    await Promise.all([bridge.ask('oA', 'x'), bridge.ask('oB', 'y')]);
    const elapsed = Date.now() - began;

    assert.equal(created, 2);
    assert.ok(elapsed < 150, `不同用户应并行，实际耗时 ${elapsed}ms`);
  });
});

/* ============================== 超时与错误 ============================== */

describe('超时与错误处理', () => {
  test('超时会取消并如实报错，而不是无限挂着', async () => {
    const agent = makeFakeAgent();
    agent.whenIdle = () => new Promise(() => {}); // 永不 settle
    const bridge = createBridge({
      logger: silent,
      turnTimeoutMs: 60,
      createAgent: async () => agent,
    });

    const result = await bridge.ask('oUser', '跑一个很慢的任务');
    assert.equal(result.ok, false);
    assert.match(result.error, /超时/);
    assert.equal(agent.cancelled !== null, true, '超时后应当调用 cancel');
  });

  test('创建 agent 失败时返回错误，不抛出', async () => {
    const bridge = createBridge({
      logger: silent,
      createAgent: async () => { throw new Error('工作区不可用'); },
    });
    const result = await bridge.ask('oUser', 'x');
    assert.equal(result.ok, false);
    assert.match(result.error, /工作区不可用/);
  });

  test('followup 抛异常时返回错误', async () => {
    const bridge = createBridge({
      logger: silent,
      createAgent: async () => makeFakeAgent({ followupThrows: true }),
    });
    const result = await bridge.ask('oUser', 'x');
    assert.equal(result.ok, false);
    assert.match(result.error, /followup 失败/);
  });

  test('一轮失败不会卡住后续消息', async () => {
    let call = 0;
    const bridge = createBridge({
      logger: silent,
      createAgent: async () => {
        call += 1;
        const a = makeFakeAgent();
        if (call === 1) a.followup = () => { throw new Error('第一次故意失败'); };
        return a;
      },
    });

    const bad = await bridge.ask('oA', '第一条');
    assert.equal(bad.ok, false);
    const good = await bridge.ask('oB', '第二条');
    assert.equal(good.ok, true, '前一个用户的失败不能影响后一个');
  });
});

/* ============================== 会话数上限 ============================== */

describe('会话数上限', () => {
  test('超出上限时淘汰最久未使用的会话', async () => {
    const agents = new Map();
    let counter = 0;
    const bridge = createBridge({
      logger: silent,
      maxSessions: 2,
      createAgent: async (openid) => {
        counter += 1;
        const a = makeFakeAgent({ reply: `回复${counter}` });
        agents.set(openid, a);
        return a;
      },
    });

    await bridge.ask('oA', 'x');
    await sleep(5);
    await bridge.ask('oB', 'y');
    await sleep(5);
    await bridge.ask('oC', 'z'); // 触发淘汰最久未用的 oA

    assert.equal(bridge.sessionCount, 2, '常驻会话不应超过上限');
    assert.equal(bridge.hasSession('oA'), false, 'oA 应当被淘汰');
    assert.equal(agents.get('oA').disposed, true, '被淘汰的会话必须被释放');
    assert.equal(bridge.hasSession('oC'), true);
  });
});
