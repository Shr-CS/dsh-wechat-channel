/**
 * 生成一条带正确签名的回调 URL，用于本地排查。
 *
 * 公众号后台保存失败时，用它可以区分到底是「签名算错了」还是「公网地址不通」。
 *
 * 用法：
 *   node tools/sign.js <token> [path] [echostr]
 *
 * 示例：
 *   node tools/sign.js dshwechat_9f3a7c1e4b2d6a80 /wechat ECHO_TEST
 */

import { signatureOf } from '../lib/protocol.js';

const [, , token, path = '/wechat', echostr] = process.argv;

if (!token) {
  console.error('用法: node tools/sign.js <token> [path] [echostr]');
  process.exit(1);
}

// 固定时间戳，便于复现同一条 URL
const timestamp = process.env.SIGN_TS || '1735689600';
const nonce = process.env.SIGN_NONCE || 'abc123xyz';
const signature = signatureOf(token, timestamp, nonce);

const params = new URLSearchParams({ signature, timestamp, nonce });
if (echostr) params.set('echostr', echostr);

const target = process.env.SIGN_BASE
  ? `${process.env.SIGN_BASE.replace(/\/$/, '')}${path}`
  : path;

console.log(`${target}?${params.toString()}`);
