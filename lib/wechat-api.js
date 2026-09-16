/**
 * 微信公众号服务端 API 客户端：access_token 管理与「客服消息」异步推送。
 *
 * 为什么必须用客服消息：
 *   公众号的**被动回复**受 5 秒超时硬约束，而 DSH 跑一轮任务动辄几分钟。
 *   所以收到消息时先用被动回复发一条回执把请求关掉，
 *   真正的结果稍后用「客服消息接口」主动推给用户。
 *
 * 本模块不依赖 Cordis，fetch 可注入，因此能用假服务器完整测试。
 */

const DEFAULT_BASE = 'https://api.weixin.qq.com';

/** token 有效期 7200 秒；提前 300 秒过期，避免边界上正好失效 */
const TOKEN_TTL_MS = 7200 * 1000;
const TOKEN_EARLY_REFRESH_MS = 300 * 1000;

/** 客服消息文本上限约 2048 字节（UTF-8），留点余量 */
export const MAX_TEXT_BYTES = 1900;

/** 这些 errcode 表示 token 失效，应当刷新后重试一次 */
const TOKEN_INVALID_CODES = new Set([40001, 40014, 41001, 42001, 42007, 42009]);

/** 按 UTF-8 字节数把长文本切成多条，且尽量在换行处断开 */
export function chunkText(text, limit = MAX_TEXT_BYTES) {
  const source = String(text ?? '');
  if (Buffer.byteLength(source, 'utf8') <= limit) return [source];

  const chunks = [];
  let current = '';
  let currentBytes = 0;

  for (const line of source.split('\n')) {
    for (const piece of splitByBytes(line, limit)) {
      const pieceBytes = Buffer.byteLength(piece, 'utf8');
      const separatorBytes = current === '' ? 0 : 1;

      if (currentBytes + separatorBytes + pieceBytes > limit) {
        if (current !== '') chunks.push(current);
        current = piece;
        currentBytes = pieceBytes;
      } else {
        current = current === '' ? piece : `${current}\n${piece}`;
        currentBytes += separatorBytes + pieceBytes;
      }
    }
  }
  if (current !== '') chunks.push(current);
  return chunks.length ? chunks : [''];
}

/** 把单行按字节上限硬切 */
function splitByBytes(line, limit) {
  if (Buffer.byteLength(line, 'utf8') <= limit) return [line];
  const out = [];
  let buf = '';
  for (const char of line) {
    if (Buffer.byteLength(buf + char, 'utf8') > limit) {
      out.push(buf);
      buf = char;
    } else {
      buf += char;
    }
  }
  if (buf !== '') out.push(buf);
  return out;
}

/**
 * 创建 API 客户端。
 *
 * @param {object} options
 * @param {string} options.appId
 * @param {string} options.appSecret
 * @param {object} [options.logger]       { info, warn }
 * @param {Function} [options.fetchImpl]  可注入，默认全局 fetch
 * @param {Function} [options.now]        可注入时钟，便于测试过期逻辑
 * @param {string} [options.baseUrl]      可注入基址，便于测试
 */
export function createWeChatApi({
  appId,
  appSecret,
  logger = { info() {}, warn() {} },
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  baseUrl = DEFAULT_BASE,
}) {
  let token = null;
  let tokenExpiresAt = 0;
  /** 并发去重：多个推送同时发现 token 过期时只发一次请求 */
  let inflight = null;

  const configured = Boolean(appId && appSecret);

  async function requestJson(url, init) {
    const response = await fetchImpl(url, init);
    const text = await response.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`微信接口返回的不是 JSON（HTTP ${response.status}）：${text.slice(0, 200)}`);
    }
    return payload;
  }

  /** 取 access_token，带缓存与并发去重 */
  async function getAccessToken({ force = false } = {}) {
    if (!configured) throw new Error('未配置 appId / appSecret，无法调用微信接口');
    if (!force && token && now() < tokenExpiresAt) return token;
    if (inflight) return inflight;

    inflight = (async () => {
      try {
        const url = `${baseUrl}/cgi-bin/token?grant_type=client_credential` +
          `&appid=${encodeURIComponent(appId)}&secret=${encodeURIComponent(appSecret)}`;
        const payload = await requestJson(url, { method: 'GET' });

        if (payload.errcode) {
          throw new Error(`获取 access_token 失败 ${payload.errcode}: ${payload.errmsg}`);
        }
        if (!payload.access_token) {
          throw new Error('获取 access_token 失败：响应里没有 access_token');
        }

        token = payload.access_token;
        const expiresIn = Number(payload.expires_in) || TOKEN_TTL_MS / 1000;
        tokenExpiresAt = now() + expiresIn * 1000 - TOKEN_EARLY_REFRESH_MS;
        logger.info(`dsh-wechat: access_token 已获取，有效期 ${expiresIn} 秒`);
        return token;
      } finally {
        inflight = null;
      }
    })();

    return inflight;
  }

  /**
   * 发一条客服消息。超长文本会自动分条发送。
   * @returns {Promise<{ok:boolean, sent:number, error?:string}>}
   */
  async function sendText(openid, text) {
    if (!configured) {
      return { ok: false, sent: 0, error: '未配置 appId / appSecret' };
    }
    const chunks = chunkText(text);
    let sent = 0;

    for (const chunk of chunks) {
      const result = await sendOne(openid, chunk, true);
      if (!result.ok) return { ok: false, sent, error: result.error };
      sent += 1;
    }
    return { ok: true, sent };
  }

  /** 单条发送；allowRetry 控制 token 失效时是否刷新重试一次 */
  async function sendOne(openid, content, allowRetry) {
    try {
      const accessToken = await getAccessToken();
      const url = `${baseUrl}/cgi-bin/message/custom/send?access_token=${encodeURIComponent(accessToken)}`;
      const payload = await requestJson(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ touser: openid, msgtype: 'text', text: { content } }),
      });

      if (payload.errcode === 0) return { ok: true };

      // token 失效：强制刷新后再试一次
      if (TOKEN_INVALID_CODES.has(payload.errcode) && allowRetry) {
        logger.warn(`dsh-wechat: token 失效（${payload.errcode}），刷新后重试`);
        token = null;
        tokenExpiresAt = 0;
        await getAccessToken({ force: true });
        return sendOne(openid, content, false);
      }

      const error = `${payload.errcode}: ${payload.errmsg}`;
      logger.warn(`dsh-wechat: 客服消息发送失败 ${error}`);
      return { ok: false, error };
    } catch (err) {
      logger.warn(`dsh-wechat: 客服消息发送异常：${err.message}`);
      return { ok: false, error: err.message };
    }
  }

  return {
    get configured() {
      return configured;
    },
    getAccessToken,
    sendText,
    /** 测试与排查用：清空缓存的 token */
    resetToken() {
      token = null;
      tokenExpiresAt = 0;
    },
    get tokenCached() {
      return token !== null && now() < tokenExpiresAt;
    },
  };
}
