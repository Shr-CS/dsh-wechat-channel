/**
 * 微信消息协议层：签名、XML 解析与组装。
 *
 * 这一层**刻意不引入任何依赖**（连 schemastery 都不要），
 * 因为它是最容易写错、也最需要单独测试的部分。
 * 不依赖 Cordis 就意味着可以用纯 node:test 直接跑。
 */

import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * 微信服务器签名算法。
 *
 * 关键点：把 token、timestamp、nonce 三个值**按字典序排序**后拼接再取 SHA1。
 * 是「值的字典序」，不是「参数出现在 URL 里的顺序」——这里写错的话，
 * 公众号后台会一直提示「Token验证失败」，而且不告诉你为什么。
 *
 * @param {string} token 公众号后台填的 Token
 * @param {string|number} timestamp
 * @param {string|number} nonce
 * @returns {string} 40 位小写十六进制
 */
export function signatureOf(token, timestamp, nonce) {
  const joined = [token, String(timestamp), String(nonce)].sort().join('');
  return createHash('sha1').update(joined, 'utf8').digest('hex');
}

/** 定长比较，避免时序侧信道；长度不等或为空一律判否 */
export function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''), 'utf8');
  const right = Buffer.from(String(b ?? ''), 'utf8');
  if (left.length === 0 || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * 校验一次回调的签名。
 * @param {string} token
 * @param {{signature?:string, timestamp?:string, nonce?:string}} params
 */
export function verifySignature(token, params) {
  if (!token) return false;
  const { signature, timestamp, nonce } = params;
  if (!signature || datetimeMissing(timestamp) || datetimeMissing(nonce)) return false;
  return safeEqual(signatureOf(token, timestamp, nonce), signature);
}

function datetimeMissing(value) {
  return value === undefined || value === null || value === '';
}

/**
 * 从微信的扁平 XML 里取一个标签的值。
 * 微信消息结构固定且很浅，用正则足够；兼容 CDATA 与纯文本两种写法。
 */
export function pickTag(xml, tag) {
  const source = String(xml ?? '');
  const cdata = new RegExp(`<${tag}>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tag}>`, 'i').exec(source);
  if (cdata) return cdata[1];
  const plain = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i').exec(source);
  return plain ? plain[1] : '';
}

/** CDATA 段内不能出现 "]]>"，否则会提前截断 XML */
export function cdataSafe(text) {
  return String(text ?? '').replaceAll(']]>', ']] >');
}

/** 把微信 XML 解析成结构化消息 */
export function parseMessage(xml) {
  return {
    to: pickTag(xml, 'ToUserName'),
    from: pickTag(xml, 'FromUserName'),
    createTime: pickTag(xml, 'CreateTime'),
    msgType: pickTag(xml, 'MsgType'),
    content: pickTag(xml, 'Content'),
    msgId: pickTag(xml, 'MsgId'),
    event: pickTag(xml, 'Event'),
    eventKey: pickTag(xml, 'EventKey'),
  };
}

/** 组装被动回复的文本消息 XML */
export function buildTextReply(toUser, fromUser, content, now = Date.now()) {
  return [
    '<xml>',
    `<ToUserName><![CDATA[${cdataSafe(toUser)}]]></ToUserName>`,
    `<FromUserName><![CDATA[${cdataSafe(fromUser)}]]></FromUserName>`,
    `<CreateTime>${Math.floor(now / 1000)}</CreateTime>`,
    '<MsgType><![CDATA[text]]></MsgType>',
    `<Content><![CDATA[${cdataSafe(content)}]]></Content>`,
    '</xml>',
  ].join('');
}

/** 组装关注时的欢迎语 */
export function buildSubscribeReply(openid) {
  return [
    '已连接 DeepSeek Harness。',
    '',
    `你的 openid：`,
    openid,
    '',
    '把它填进插件配置的 allowFrom 即可开始下指令。',
  ].join('\n');
}

/** 组装未授权提示 */
export function buildUnauthorizedReply(openid) {
  return [
    '未授权。',
    '',
    '你的 openid 是：',
    openid,
    '',
    '请把它加入插件配置的 allowFrom。',
  ].join('\n');
}
