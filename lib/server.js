/**
 * 路由处理器层：把微信协议层接到 node:http 上。
 *
 * 这一层不依赖 Cordis，只依赖 node:http 与 protocol.js，
 * 因此可以用假的 req/res 直接驱动测试，不必启动整个 harness。
 */

import {
  verifySignature,
  parseMessage,
  buildTextReply,
  buildSubscribeReply,
  buildUnauthorizedReply,
} from './protocol.js';

/** 微信要求 5 秒内响应；留 1 秒余量，超过就先用回执把这次请求关掉 */
export const RESPONSE_DEADLINE_MS = 4000;

export function normalizePath(raw) {
  const value = String(raw ?? '/wechat').trim() || '/wechat';
  return value.startsWith('/') ? value : `/${value}`;
}

export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error(`请求体超过 ${limit} 字节上限`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function sendText(res, status, body, contentType = 'text/plain; charset=utf-8') {
  const payload = String(body ?? '');
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(payload, 'utf8'),
  });
  res.end(payload);
}

const sendXml = (res, body) => sendText(res, 200, body, 'application/xml; charset=utf-8');

/** 默认的 handleMessage：阶段一占位，阶段二替换为真正的 DSH 桥接 */
async function defaultHandleMessage(message) {
  return `收到：${message.content}`;
}

/**
 * 构造三个 route handler。
 *
 * @param {object} deps
 * @param {object} deps.config      已解析的插件配置
 * @param {object} deps.logger      { info, warn } 形状的日志器
 * @param {(msg:object)=>Promise<string|null>} [deps.handleMessage]
 *        处理一条已授权消息。**契约**：必须在 5 秒内返回。
 *        返回字符串 → 作为被动回复发回微信；
 *        返回 null   → 表示已在后台异步回复，本次只回 "success"。
 *        需要跑几分钟的工作绝不能在这里 await，应当立即返回 null。
 * @param {object} [deps.stats]     统计计数器（会被就地修改）
 */
export function createHandlers({
  config,
  logger,
  handleMessage = defaultHandleMessage,
  stats = {},
  deadlineMs = RESPONSE_DEADLINE_MS,
  runtimeStatus = () => ({ ready: true }),
}) {
  const path = normalizePath(config.path);
  const counter = {
    verified: 0,
    rejected: 0,
    messages: 0,
    timeouts: 0,
    lastFrom: '',
    lastAt: '',
    ...stats,
  };

  /** GET：微信服务器配置验证 */
  async function onVerify(req, res, url) {
    const params = {
      signature: url.searchParams.get('signature') ?? '',
      timestamp: url.searchParams.get('timestamp') ?? '',
      nonce: url.searchParams.get('nonce') ?? '',
    };
    const echostr = url.searchParams.get('echostr') ?? '';

    if (!config.token) {
      logger.warn('dsh-wechat: 未配置 token，无法完成验证');
      sendText(res, 500, 'token not configured');
      return;
    }
    if (!verifySignature(config.token, params)) {
      counter.rejected += 1;
      logger.warn('dsh-wechat: 签名不匹配 —— 请确认公众号后台的 Token 与插件配置完全一致');
      sendText(res, 403, 'signature mismatch');
      return;
    }
    counter.verified += 1;
    logger.info('dsh-wechat: 微信服务器配置验证通过 ✓');
    // 必须原样回显 echostr，微信才判定配置成功
    sendText(res, 200, echostr);
  }

  /** POST：接收用户消息 */
  async function onMessage(req, res, url) {
    const params = {
      signature: url.searchParams.get('signature') ?? '',
      timestamp: url.searchParams.get('timestamp') ?? '',
      nonce: url.searchParams.get('nonce') ?? '',
    };

    if (!verifySignature(config.token, params)) {
      counter.rejected += 1;
      sendText(res, 403, 'signature mismatch');
      return;
    }

    let xml = '';
    try {
      xml = await readBody(req, config.maxBodyBytes);
    } catch (err) {
      logger.warn(`dsh-wechat: 读取请求体失败：${err.message}`);
      sendText(res, 200, 'success'); // 回 success 让微信停止重试
      return;
    }

    const message = parseMessage(xml);

    /* -------------------- 事件消息（关注 / 取关） -------------------- */
    if (message.msgType === 'event') {
      logger.info(`dsh-wechat: 事件 ${message.event}，来自 ${message.from}`);
      if (message.event === 'subscribe') {
        sendXml(res, buildTextReply(message.from, message.to, buildSubscribeReply(message.from)));
      } else {
        sendText(res, 200, 'success');
      }
      return;
    }

    /* -------------------- 发送者白名单 -------------------- */
    // 公网可达的入口，绝不能谁发都执行
    if (config.requireWhitelist && !config.allowFrom.includes(message.from)) {
      counter.rejected += 1;
      logger.warn(`dsh-wechat: 拒绝未授权 openid ${message.from}`);
      sendXml(res, buildTextReply(message.from, message.to, buildUnauthorizedReply(message.from)));
      return;
    }

    counter.messages += 1;
    counter.lastFrom = message.from;
    counter.lastAt = new Date().toISOString();

    /* -------------------- 交给上层，但严守 4 秒死线 -------------------- */
    let reply;
    try {
      reply = await Promise.race([
        Promise.resolve(handleMessage(message)),
        new Promise((resolve) => setTimeout(() => resolve('__DEADLINE__'), deadlineMs)),
      ]);
    } catch (err) {
      logger.warn(`dsh-wechat: 处理消息异常：${err.message}`);
      reply = `处理失败：${err.message}`;
    }

    if (reply === '__DEADLINE__') {
      // 上层没有按时返回：这次先用回执关掉请求，它的后台任务继续跑
      counter.timeouts += 1;
      logger.warn('dsh-wechat: 处理超时，已改发回执（结果应由上层异步推送）');
      sendXml(res, buildTextReply(message.from, message.to, config.receipt));
      return;
    }
    if (reply === null || reply === undefined) {
      // 上层声明会自行异步回复
      sendText(res, 200, 'success');
      return;
    }
    sendXml(res, buildTextReply(message.from, message.to, reply));
  }

  /** 自检端点：用 token 当口令，避免状态裸奔 */
  async function onStatus(req, res, url) {
    if (!config.token || url.searchParams.get('key') !== config.token) {
      sendText(res, 403, 'forbidden');
      return;
    }
    const body = JSON.stringify({
      plugin: 'dsh-wechat-channel',
      path,
      configured: {
        token: !!config.token,
        appId: !!config.appId,
        appSecret: !!config.appSecret,
      },
      // DSH 侧会话运行时是否已装配完成；不需要真的发消息就能自检
      runtime: runtimeStatus(),
      whitelist: { required: !!config.requireWhitelist, count: config.allowFrom.length },
      stats: counter,
    }, null, 2);
    sendText(res, 200, body, 'application/json; charset=utf-8');
  }

  return { onVerify, onMessage, onStatus, stats: counter, path };
}

/** 组装成 webServer.register() 认识的路由数组 */
export function createRoutes(deps) {
  const handlers = createHandlers(deps);
  const { path } = handlers;
  return {
    handlers,
    routes: [
      {
        kind: 'exact',
        path,
        handler: async (req, res) => {
          const url = new URL(req.url ?? path, 'http://localhost');
          if (req.method === 'GET') return handlers.onVerify(req, res, url);
          if (req.method === 'POST') return handlers.onMessage(req, res, url);
          sendText(res, 405, 'method not allowed');
        },
      },
      {
        kind: 'exact',
        path: `${path}/status`,
        handler: (req, res) => handlers.onStatus(req, res, new URL(req.url ?? path, 'http://localhost')),
      },
    ],
  };
}
