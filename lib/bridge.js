/**
 * 桥接层：把微信消息变成 DSH 会话的一轮对话，并把回复取回来。
 *
 * 设计要点：
 *  1. **依赖注入**。本模块只认识一个抽象的 agent 形状
 *     （`followup` / `whenIdle` / `session.deriveMessages`），
 *     真实实现由 index.js 用 `ctx.agents` 组装。因此可以用假 agent 完整测试，
 *     不必启动整个 harness。
 *  2. **每个微信用户一个常驻会话**，这样多轮对话有上下文。
 *  3. **每用户串行**。同一用户连发两条消息时排队，避免两个轮次并发操作同一会话。
 *  4. **超时可控**。DSH 跑一轮可能很久，超时后取消并如实告知用户，而不是无限挂着。
 */

/** 把会话状态压缩成一行，用于「取不到回复」时的诊断 */
export function summarizeSession(session) {
  if (!session) return '会话对象不存在';
  const parts = [];

  try {
    parts.push(`seq=${session.seq}`);
  } catch (err) {
    parts.push(`seq读取失败(${err.message})`);
  }
  try {
    const id = session.header && session.header.id;
    if (id) parts.push(`id=${id}`);
  } catch { /* header 不可读就不报 */ }

  try {
    const messages = session.deriveMessages();
    if (Array.isArray(messages)) {
      parts.push(`消息${messages.length}条`);
      if (messages.length) {
        const counts = {};
        for (const message of messages) {
          const role = (message && message.role) || '未知';
          counts[role] = (counts[role] ?? 0) + 1;
        }
        parts.push(Object.entries(counts).map(([role, n]) => `${role}:${n}`).join(' '));
      }
    } else {
      parts.push('deriveMessages 返回非数组');
    }
  } catch (err) {
    parts.push(`deriveMessages失败(${err.message})`);
  }

  // 事件分布往往能直接看出模型调用为什么没产出
  try {
    if (typeof session.snapshotEvents === 'function') {
      const events = session.snapshotEvents();
      if (Array.isArray(events) && events.length) {
        const counts = {};
        for (const event of events) {
          const type = (event && event.type) || '?';
          counts[type] = (counts[type] ?? 0) + 1;
        }
        parts.push('事件分布=' + Object.entries(counts).map(([type, n]) => `${type}×${n}`).join(' '));
      }
    }
  } catch { /* 事件读取失败不影响主诊断 */ }

  return parts.join('，');
}

/** 把会话日志的构成压缩成一行 */
export function summarizeMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return '会话日志为空';
  const counts = {};
  for (const message of messages) {
    const role = message && message.role ? message.role : '未知';
    counts[role] = (counts[role] ?? 0) + 1;
  }
  const last = messages[messages.length - 1];
  const blocks = Array.isArray(last && last.content)
    ? last.content.map((b) => (b && b.type) || '?').join('/')
    : '无内容数组';
  const countsText = Object.entries(counts).map(([role, n]) => `${role}:${n}`).join(' ');
  return `日志 ${messages.length} 条（${countsText}），末条 role=${last && last.role} blocks=${blocks}`;
}

/** 从会话消息里取出最后一条助手消息的纯文本 */
export function extractAssistantText(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || message.role !== 'assistant') continue;
    const blocks = Array.isArray(message.content) ? message.content : [];
    const text = blocks
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .trim();
    if (text !== '') return text;
  }
  return '';
}

/** 把 agent 的回复整理成适合微信阅读的样子 */
export function formatForWeChat(text, { maxChars = 4000 } = {}) {
  let out = String(text ?? '').trim();
  if (out === '') return '(DSH 没有返回文本内容)';
  // 微信不渲染 Markdown 表格，把它们拉平成可读文本
  out = out.replace(/^\|(.+)\|$/gm, (line) =>
    line.split('|').filter((cell) => cell.trim() !== '').map((cell) => cell.trim()).join(' · '));
  out = out.replace(/^#{1,6}\s+/gm, '');
  if (out.length > maxChars) out = `${out.slice(0, maxChars)}\n\n…（内容过长已截断）`;
  return out;
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 等驱动器真正把队列里的消息接走。
 *
 * 为什么需要：`followup()` 只是「排队并唤醒驱动器」，唤醒是异步的。
 * 紧接着调用 `whenIdle()` 时，agent 此刻仍是空闲的，于是它**立刻兑现**，
 * 整轮被判定为 0 秒完成、没有任何产出（实测踩到过）。
 * 这里以「会话日志变长」作为驱动器确实启动的证据。
 */
async function waitForWorkStart(entry, beforeLength, maxWaitMs) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    try {
      if (entry.agent.session.deriveMessages().length > beforeLength) return true;
    } catch { /* 会话尚未可读，继续等 */ }
    await sleep(50);
  }
  return false;
}

/**
 * @param {object} options
 * @param {(openid:string)=>Promise<object>} options.createAgent
 *        为一个微信用户创建 agent。返回对象需具备
 *        `followup(message)`、`whenIdle()`、`session.deriveMessages()`、`dispose()`。
 * @param {object} options.logger
 * @param {number} [options.turnTimeoutMs]  单轮最长等待时间
 * @param {number} [options.maxSessions]    常驻会话上限，超出淘汰最久未用的
 */
export function createBridge({
  createAgent,
  logger = { info() {}, warn() {} },
  turnTimeoutMs = 10 * 60 * 1000,
  maxSessions = 20,
}) {
  /** openid -> { agent, lastUsed, busy } —— 只放真实会话 */
  const sessions = new Map();
  /**
   * openid -> Promise —— 每用户的串行队列。
   * 必须与会话表分开：早期版本把占位对象写进会话表，导致 getSession 取到
   * 一个还没有 agent 的壳，随后 entry.agent 为 undefined，且会话数统计虚高。
   */
  const chains = new Map();

  async function getSession(openid) {
    const existing = sessions.get(openid);
    if (existing) {
      existing.lastUsed = Date.now();
      return existing;
    }

    // 超出上限时淘汰最久未使用的
    if (sessions.size >= maxSessions) {
      let oldestKey = null;
      let oldest = Infinity;
      for (const [key, value] of sessions) {
        if (value.busy) continue; // 正在跑的不淘汰
        if (value.lastUsed < oldest) { oldest = value.lastUsed; oldestKey = key; }
      }
      if (oldestKey !== null) {
        logger.info(`dsh-wechat: 会话数达到上限，淘汰 ${oldestKey}`);
        await disposeSession(oldestKey);
      }
    }

    const agent = await createAgent(openid);
    const entry = { agent, lastUsed: Date.now(), busy: false };
    sessions.set(openid, entry);
    return entry;
  }

  async function disposeSession(openid) {
    const entry = sessions.get(openid);
    if (!entry) return;
    sessions.delete(openid);
    try {
      await entry.agent.dispose();
    } catch (err) {
      logger.warn(`dsh-wechat: 释放会话失败：${err.message}`);
    }
  }

  /** 真正跑一轮。契约：任何失败都必须返回 {ok:false}，绝不向外抛 */
  async function runTurn(openid, prompt) {
    const started = Date.now();
    const timedOut = deferred();
    let entry = null;
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        timedOut.resolve(true);
        resolve('__TIMEOUT__');
      }, turnTimeoutMs);
    });

    try {
      // getSession 可能因为工作区不可用等原因失败，必须也在保护范围内
      entry = await getSession(openid);
      entry.busy = true;

      // followup 之前先记下日志长度，作为「驱动器是否启动」的基线
      const beforeLength = entry.agent.session.deriveMessages().length;

      entry.agent.followup({
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'plugin', plugin: 'dsh-wechat-channel' },
      });

      await waitForWorkStart(entry, beforeLength, 8000);

      const outcome = await Promise.race([
        entry.agent.whenIdle().then(() => '__DONE__'),
        timeout,
      ]);

      if (outcome === '__TIMEOUT__') {
        logger.warn(`dsh-wechat: 单轮超过 ${Math.round(turnTimeoutMs / 1000)} 秒，取消`);
        try {
          if (typeof entry.agent.cancel === 'function') entry.agent.cancel('dsh-wechat: turn timeout');
        } catch { /* 取消失败不影响返回 */ }
        return { ok: false, error: `处理超时（超过 ${Math.round(turnTimeoutMs / 1000)} 秒）`, elapsedMs: Date.now() - started };
      }

      const session = entry.agent.session;
      const messages = session.deriveMessages();
      const text = extractAssistantText(messages);
      if (text === '') {
        // 取不到回复时把会话与 agent 状态一并报出来，省得只能靠猜
        const agentState = typeof entry.agent.status === 'string' ? `，agent状态=${entry.agent.status}` : '';
        return {
          ok: false,
          error: `这一轮没有产生助手回复（${summarizeSession(session)}${agentState}）`,
          elapsedMs: Date.now() - started,
        };
      }
      return { ok: true, reply: formatForWeChat(text), elapsedMs: Date.now() - started };
    } catch (err) {
      logger.warn(`dsh-wechat: 执行失败：${err.message}`);
      return { ok: false, error: err.message, elapsedMs: Date.now() - started };
    } finally {
      if (timer) clearTimeout(timer);
      if (entry !== null) {
        entry.busy = false;
        entry.lastUsed = Date.now();
      }
    }
  }

  /**
   * 对外入口：为某个微信用户跑一轮，返回回复文本。
   * 同一用户的消息自动串行。
   * @returns {Promise<{ok:boolean, reply?:string, error?:string, elapsedMs:number}>}
   */
  function ask(openid, prompt) {
    const previous = chains.get(openid) ?? Promise.resolve();
    const next = previous.then(
      () => runTurn(openid, prompt),
      () => runTurn(openid, prompt),
    );
    // 队列上只保留「已结束」的语义，避免一次失败永久中断该用户的后续消息
    chains.set(openid, next.then(() => undefined, () => undefined));
    return next;
  }

  async function disposeAll() {
    const keys = [...sessions.keys()];
    for (const key of keys) await disposeSession(key);
    chains.clear();
  }

  return {
    ask,
    disposeAll,
    disposeSession,
    get sessionCount() { return sessions.size; },
    hasSession: (openid) => sessions.has(openid),
  };
}
