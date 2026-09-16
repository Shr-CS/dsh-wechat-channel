/**
 * dsh-wechat — Cordis 插件胶水层。
 *
 * 分层：
 *   protocol.js   微信签名与 XML（零依赖，可独立测）
 *   server.js     HTTP 路由处理（只依赖 protocol.js）
 *   wechat-api.js 服务端 API：access_token + 客服消息（fetch 可注入）
 *   bridge.js     微信消息 ↔ DSH 会话（agent 形状可注入）
 *   index.js      ← 本文件：只做配置声明、服务装配与生命周期
 *
 * 消息处理时序（关键，因为微信被动回复只有 5 秒）：
 *   1. 收到消息 → 立刻被动回复一条「已收到，正在处理…」把请求关掉
 *   2. 后台跑 DSH 会话（可能几分钟）
 *   3. 跑完用「客服消息接口」主动把结果推回微信
 *
 * 安全提醒：
 *   DSH 的 agent 能执行命令、读写文件。本插件把它暴露到公网，
 *   allowFrom 白名单是**唯一**准入控制，请务必保持 requireWhitelist 开启。
 */

import { createHash, randomUUID } from 'node:crypto';
import { createRoutes, normalizePath } from './server.js';
import { createWeChatApi } from './wechat-api.js';
import { createBridge } from './bridge.js';

/** 递归冻结，对齐 harness 的 deepFreeze 语义 */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

/** 把任意值压成可安全放进 JSON 的短字符串（处理循环引用与超长内容） */
function safeBrief(value, limit = 300) {
  const seen = new WeakSet();
  let text;
  try {
    text = JSON.stringify(value, (_key, item) => {
      if (typeof item === 'object' && item !== null) {
        if (seen.has(item)) return '[循环]';
        seen.add(item);
      }
      if (typeof item === 'function') return '[函数]';
      if (typeof item === 'bigint') return String(item);
      return item;
    });
  } catch (err) {
    text = `[无法序列化: ${err.message}]`;
  }
  if (text === undefined) text = String(value);
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * 复刻 @deepseek-ai/dsh-llm 的 createUserMessage。
 *
 * 为什么自己实现而不是 import：本插件以 link: 方式装入 profile，
 * 解析不到 profile 的传递依赖（实测 `Cannot find package '@deepseek-ai/dsh-llm'`）。
 * 而该函数本体只有一行：
 *     { ...input, role: 'user', id: brandString(randomUUID()) }
 * 其中 brandString 只是类型标记，运行时会被擦除，普通字符串即可。
 *
 * **关键**：必须带 role:'user' 与唯一 id。
 * 少了这两样，消息会进收件箱、轮次也会启动，但**永远不会成为模型输入** ——
 * 表现为 step 空转、日志里既没有 user/message 也没有 request/header（实测踩到过）。
 */
function createUserMessage(input) {
  return deepFreeze({
    ...input,
    role: 'user',
    id: `wechat-msg-${randomUUID()}`,
  });
}

export const name = 'dsh-wechat-channel';

/** 只强依赖 webServer。会话运行时的服务用 ctx.inject 软依赖装配，
 *  这样即使某个服务缺失，插件仍能启动并给出可读诊断，而不是拖垮整个 profile。 */
export const inject = ['webServer'];

/**
 * 注意：这里**不要**照搬 dsh-webhook 的 installInitialModelSelection。
 *
 * 它会在 `agent/request` 监听器里访问 `sessionCtx.agent`，而 setup 的上下文
 * 并没有注入 `agent` 服务，Cordis 会直接抛
 * `cannot get property "agent" without inject`，
 * 结果是**每一轮 turn 都以错误结束**、step 空转、日志里既没有
 * user/message 也没有 request/header（实测踩到过，靠诊断监听器才抓出来）。
 *
 * 我们不需要它：create() 时已显式传入 agentOptions（provider + model），
 * 循环会把这个路由记录进 request/header，前缀本来就是确定的。
 */


/**
 * 配置规整：手写，**不依赖 schemastery**。
 *
 * 先前用 schemastery 声明 Config，但本插件以 `link:` 装入 profile，
 * Node 解析不透「我的 node_modules → profile 的 node_modules → .dsh-module-fallback」
 * 这种多重 junction，导入时抛 `Cannot find package 'schemastery'`。
 * 而 Cordis 的加载器**先 import 再 apply** —— 导入失败会让
 * **整个 DSH 启动中断**（日志：`Harness entry failed during startup`）。
 * 手写规整后本插件零运行时依赖，从根上消除这类问题。
 *
 * 不导出 `Config`：Cordis 在没有 Config 时会把原始 config 原样交给 apply，
 * 这里统一补默认值并做类型收敛。
 */
export function normalizeConfig(input) {
  const src = (input && typeof input === 'object') ? input : {};

  const str = (value, fallback = '') => {
    if (typeof value === 'string') return value;
    if (value === undefined || value === null) return fallback;
    return String(value);
  };
  const bool = (value, fallback) => {
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    return fallback;
  };
  const int = (value, fallback, min) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.round(n));
  };
  const list = (value) =>
    Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item !== '') : [];

  return {
    /** 公众号后台「服务器配置」里填的 Token，必须与本插件完全一致 */
    token: str(src.token),
    /** 测试号的 appID（异步回复必需） */
    appId: str(src.appId),
    /** 测试号的 appsecret（异步回复必需） */
    appSecret: str(src.appSecret),
    /** 回调路径。刻意避开 /wechat：第三方包 dsh-wechat 注册了 /wechat/status，
     *  重复路由会让本插件整个激活失败，故走 /wechat-mp。 */
    path: str(src.path) || '/wechat-mp',
    /** 允许下指令的微信 openid 白名单 */
    allowFrom: list(src.allowFrom),
    /** 是否强制白名单；安全起见默认开启，不要关 */
    requireWhitelist: bool(src.requireWhitelist, true),
    /** 收到消息时先回给用户的短回执 */
    receipt: str(src.receipt) || '已收到，正在处理…',
    /** 单条消息最大字节数 */
    maxBodyBytes: int(src.maxBodyBytes, 262144, 1024),
    /** DSH 会话的工作目录；留空则用当前进程的工作目录 */
    workspacePath: str(src.workspacePath),
    /** agent preset；留空则不挂载 preset，使用部署默认值 */
    agentPreset: str(src.agentPreset),
    /** permission preset；留空则使用部署默认值 */
    permissionPreset: str(src.permissionPreset),
    /** 单轮最长等待时间（毫秒） */
    turnTimeoutMs: int(src.turnTimeoutMs, 600000, 1000),
    /** 常驻会话上限，超出淘汰最久未用的 */
    maxSessions: int(src.maxSessions, 20, 1),
    /** 微信 API 基址；指向代理或本地假服务器时有用 */
    apiBaseUrl: str(src.apiBaseUrl) || 'https://api.weixin.qq.com',
    /** 采集会话事件并通过状态端点暴露，用于排查 */
    diagnostics: bool(src.diagnostics, true),
  };
}

export const apply = (ctx, rawConfig) => {
  const config = normalizeConfig(rawConfig);
  const path = normalizePath(config.path);

  /* ------------------------------ 依赖装配 ------------------------------ */

  const api = createWeChatApi({
    appId: config.appId,
    appSecret: config.appSecret,
    logger: ctx.logger,
    baseUrl: config.apiBaseUrl,
  });

  /** 会话运行时是否已就绪；未就绪时 handleMessage 会给出可读提示 */
  let bridge = null;
  let runtimeError = '会话运行时尚未装配（agents / workspaceRegistry / agentPresets / permissionPresets 未就绪）';
  /** 装配期观测到的默认模型选择，暴露到状态端点便于排查 */
  let observedModel = null;

  /**
   * 会话事件环形缓冲，通过状态端点暴露。
   *
   * 为什么需要：DSH 的日志不落到我能读到的地方（`dsh web` 的 stdout 几乎是空的），
   * 排查「会话跑了但没产出」时完全靠猜。这里只订阅**通知型**事件（不改行为），
   * 把事件流抓下来供诊断。
   */
  const debugEvents = [];
  const DEBUG_LIMIT = 60;
  function recordEvent(type, payload) {
    debugEvents.push({
      at: new Date().toISOString(),
      type,
      brief: safeBrief(payload),
    });
    if (debugEvents.length > DEBUG_LIMIT) debugEvents.shift();
  }

  if (!config.token) {
    ctx.logger.warn(
      'dsh-wechat-channel: 未配置 token，回调会拒绝所有请求。' +
      '请在 profile 的 cordis.patch.yml 里为本插件补上 config.token。',
    );
  }
  if (config.allowFrom.length === 0) {
    ctx.logger.warn(
      'dsh-wechat-channel: allowFrom 白名单为空，任何人都无法下指令。' +
      '关注测试号后插件会回信告诉对方 openid，填进来即可。',
    );
  }
  if (!api.configured) {
    ctx.logger.warn(
      'dsh-wechat-channel: 未配置 appId / appsecret，结果无法异步推回微信，' +
      '只能被动回复回执。请在测试号页面取得凭据后填入配置。',
    );
  }

  /* --------------------------- DSH 会话运行时 --------------------------- */

  ctx.inject(['agents', 'workspaceRegistry', 'agentPresets', 'permissionPresets', 'agentDefaultModel'], (agentCtx) => {
    const workspacePath = config.workspacePath || process.cwd();

    try {
      observedModel = agentCtx.agentDefaultModel.currentSelection();
    } catch (err) {
      observedModel = { error: err.message };
    }

    /**
     * 打开（复用或新建）一个会话。
     *
     * 为什么不能只用 create()：会话是**持久化**的。
     * DSH 重启后同一个 openid 再建会话会直接报
     * `session "wechat-xxx" already exists`（实测踩到过）。
     * 而「重启后继续之前的对话」恰恰是聊天机器人最常见的场景。
     *
     * 这里严格照搬 harness 自己 AgentLoop.restoreOrCreateConfigured 的做法：
     *   1. 用 sessionPersistence.list() 查会话是否已存在
     *   2. 存在 → agents.resume({ resumeSessionId, agentOptions, setup })
     *   3. 不存在 → agents.create({ sessionId, meta, agentOptions, setup })
     * 注意 resume 的参数名是 **resumeSessionId**，传 sessionId 会静默走错分支。
     */
    const openAgent = async ({ sessionId, meta, agentOptions, setup }) => {
      // ctx.get(name) 与 ctx.<service> 两种取法都试
      const persistence = (typeof agentCtx.get === 'function' ? agentCtx.get('sessionPersistence') : undefined)
        ?? agentCtx.sessionPersistence;

      let listCount = -1;
      let knownExists = false;
      if (persistence && typeof persistence.list === 'function') {
        try {
          const headers = await persistence.list();
          listCount = Array.isArray(headers) ? headers.length : -1;
          knownExists = Array.isArray(headers) && headers.some((header) => header.id === sessionId);
        } catch { /* list 不可用时退回到 create 的权威判断 */ }
      }

      const resume = () => agentCtx.agents.resume({ resumeSessionId: sessionId, agentOptions, setup });

      if (knownExists) {
        const handle = await resume();
        ctx.logger.info(`dsh-wechat-channel: 复用已有会话 ${sessionId}`);
        return handle;
      }

      try {
        return await agentCtx.agents.create({ sessionId, meta, agentOptions, setup });
      } catch (err) {
        // create 才是「会话是否已存在」的权威判断：它说已存在，就直接复用。
        // 不要依赖 persistence.list() —— 实测它会漏掉确实存在的会话（返回 9 条却没命中）。
        if (/already exists/i.test(String(err.message))) {
          ctx.logger.info(`dsh-wechat-channel: create 报告会话已存在，改为复用 ${sessionId}`);
          try {
            return await resume();
          } catch (resumeError) {
            throw new Error(
              `会话已存在但复用失败：${resumeError.message}` +
              `｜诊断：list 条数=${listCount}，resumeSessionId=${sessionId}`,
            );
          }
        }
        throw new Error(
          `${err.message}｜诊断：持久化后端=${persistence ? '有' : '无'}，list 条数=${listCount}`,
        );
      }
    };

    /**
     * 为一个微信用户创建常驻 agent。
     * 这里严格照搬 @deepseek-ai/dsh-webhook 的做法，
     * 因为那是 harness 内部创建「工作区支撑的会话」的权威流程。
     */
    const createAgent = async (openid) => {
      // 会话 id 里带上工作目录的指纹。
      // 为什么：cwd 是固化在会话头里的，resume 会沿用旧值 ——
      // 若 会话 id 固定为 wechat-<openid>，改了 workspacePath 也不会生效，
      // agent 会一直在旧目录里干活（实测踩到过）。带上指纹后换目录即新会话。
      const wsTag = createHash('sha1').update(workspacePath).digest('hex').slice(0, 8);
      const sessionId = `wechat-${openid}-${wsTag}`;

      const workspace = await agentCtx.workspaceRegistry.create(workspacePath);

      let presetId = null;
      if (config.agentPreset) {
        const preset = await agentCtx.agentPresets.resolve(config.agentPreset);
        presetId = preset.id;
      }

      // 取部署默认模型，作为这条会话的初始路由
      const selected = agentCtx.agentDefaultModel.currentSelection();
      const agentOptions = { provider: selected.provider, model: selected.model };

      const handle = await openAgent({
        sessionId,
        meta: {
          cwd: workspace.path,
          ...(presetId ? { agentPreset: presetId } : {}),
        },
        agentOptions,
        setup: async (sessionCtx) => {
          if (presetId) await agentCtx.agentPresets.mount(sessionCtx, presetId);

          // 诊断用：只订阅通知型事件，不做任何拦截，因此不会改变正常行为。
          // 注意 session/event 的第一个参数是 Session 本身，事件要从日志尾部取。
          if (!config.diagnostics) return;
          try {
            sessionCtx.on('session/event', (maybeSession) => {
              try {
                const session = (maybeSession && typeof maybeSession.snapshotEvents === 'function')
                  ? maybeSession
                  : sessionCtx.agent && sessionCtx.agent.session;
                if (!session || typeof session.snapshotEvents !== 'function') return;
                const events = session.snapshotEvents();
                const last = events[events.length - 1];
                if (last) recordEvent(last.type, last.data);
              } catch (err) {
                recordEvent('event-read-error', err.message);
              }
            });
            sessionCtx.on('agent/status', (payload) => {
              recordEvent('agent/status', typeof payload === 'string' ? payload : '状态变化');
            });
            recordEvent('instrument', '已挂上诊断监听器');
          } catch (err) {
            recordEvent('instrument-error', err.message);
          }
        },
      });

      try {
        await workspace.attachSession(sessionId);
        if (config.permissionPreset) {
          agentCtx.permissionPresets.set(handle.agent.session, config.permissionPreset);
        }
      } catch (err) {
        // 装配失败必须回滚，否则会漏掉一个没被登记的 agent
        try { await handle.dispose(); } catch { /* 尽力而为 */ }
        throw err;
      }

      return {
        followup: (message) => handle.agent.followup(createUserMessage({
          content: message.content,
          source: message.source,
        })),
        whenIdle: () => handle.agent.whenIdle(),
        cancel: (cause) => handle.agent.cancel(cause),
        // 用 getter 直接返回真实 Session，不要包一层 ——
        // 包一层会让 seq / header / snapshotEvents 全部读不到，诊断信息变成假象
        get session() { return handle.agent.session; },
        get status() { return handle.agent.status; },
        dispose: async () => {
          try { await workspace.detachSession(sessionId); } catch { /* 尽力而为 */ }
          await handle.dispose();
        },
      };
    };

    bridge = createBridge({
      createAgent,
      logger: ctx.logger,
      turnTimeoutMs: config.turnTimeoutMs,
      maxSessions: config.maxSessions,
    });

    ctx.logger.info(
      `dsh-wechat-channel: 会话运行时已就绪（工作区 ${workspacePath}` +
      `${config.agentPreset ? `，preset ${config.agentPreset}` : ''}）`,
    );
    runtimeError = null;

    ctx.effect(() => () => bridge?.disposeAll(), 'dsh-wechat-channel: sessions');
  });

  /* ------------------------------ 消息处理 ------------------------------ */

  /**
   * 跑一轮 DSH 并把结果推回微信。
   * 刻意与 HTTP 响应解耦：微信只给 5 秒，这里可能要跑几分钟。
   */
  async function runAndPush(message) {
    const started = Date.now();
    recordEvent('turn-begin', `来自 ${message.from}：${String(message.content).slice(0, 60)}`);
    try {
      const result = await bridge.ask(message.from, message.content);
      recordEvent('turn-result', result.ok
        ? `成功，用时 ${result.elapsedMs}ms，回复 ${String(result.reply).length} 字`
        : `失败：${result.error}`);
      const text = result.ok
        ? result.reply
        : `执行失败：${result.error}`;
      // 明确的抬头分隔：之前只有一行「✅ 用时 N 秒」，正文若很短会被误以为「没回复」
      const body = result.ok
        ? `🤖 DSH 回复（用时 ${Math.round(result.elapsedMs / 1000)} 秒）\n────────────\n${text}`
        : `❌ DSH 执行失败\n────────────\n${text}`;

      const push = await api.sendText(message.from, body);
      if (!push.ok) {
        recordEvent('push-failed', push.error);
        ctx.logger.warn(`dsh-wechat-channel: 结果推送失败：${push.error}`);
      } else {
        recordEvent('push-ok', `${push.sent} 条`);
        ctx.logger.info(
          `dsh-wechat-channel: 已回推结果给 ${message.from}（${push.sent} 条，` +
          `总耗时 ${Math.round((Date.now() - started) / 1000)} 秒）`,
        );
      }
    } catch (err) {
      recordEvent('turn-threw', err.message);
      ctx.logger.warn(`dsh-wechat-channel: 后台任务异常：${err.message}`);
      await api.sendText(message.from, `内部错误：${err.message}`).catch(() => {});
    }
  }

  ctx.effect(() => {
    const { routes } = createRoutes({
      config,
      logger: ctx.logger,
      runtimeStatus: () => ({
        ready: bridge !== null,
        error: runtimeError,
        sessions: bridge ? bridge.sessionCount : 0,
        model: observedModel,
        agentPreset: config.agentPreset || '(未设置)',
        permissionPreset: config.permissionPreset || '(未设置)',
        recentEvents: debugEvents.slice(-40),
      }),
      handleMessage: async (message) => {
        // 只有非文本消息需要在这里挡掉；授权已由 server.js 完成
        if (message.msgType !== 'text') {
          return `暂时只支持文本消息，收到的是 ${message.msgType}。`;
        }
        if (message.content.trim() === '') {
          return '消息内容为空。';
        }
        if (!bridge) {
          return runtimeError
            ? `DSH 会话运行时未就绪：${runtimeError}`
            : 'DSH 会话运行时尚未就绪（缺少 agents / workspaceRegistry 等服务），请稍后重试。';
        }
        if (!api.configured) {
          return '插件尚未配置 appId / appsecret，无法把结果推回微信。\n' +
                 '请在测试号页面取得凭据后填入配置。';
        }

        // 立刻回执把 HTTP 请求关掉（微信 5 秒限制），真正的活在后台跑
        void runAndPush(message);
        return `${config.receipt}\n\n任务已交给 DSH，完成后我会主动把结果发给你。`;
      },
    });

    const disposers = routes.map((route) => ctx.webServer.register(route));
    ctx.logger.info(
      `dsh-wechat-channel: 回调已挂载 → 本机 http://127.0.0.1:${ctx.webServer.port}${path}` +
      `　（公众号后台的 URL 填「公网地址 + ${path}」）`,
    );
    return () => {
      for (const dispose of disposers) dispose();
    };
  }, 'dsh-wechat-channel: routes');
};

export default { name, inject, normalizeConfig, apply };
