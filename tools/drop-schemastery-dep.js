/**
 * 一次性补丁脚本：把 lib/index.js 里对 schemastery 的依赖彻底去掉。
 *
 * 为什么要去掉：
 *   本插件以 link: 装入 profile，Node 解析不透
 *   「我的 node_modules → profile 的 node_modules → .dsh-module-fallback」
 *   这种多重 junction，导入时抛 Cannot find package 'schemastery'。
 *   而 Cordis 是「先 import 再 apply」——导入失败会让整个 DSH 启动中断。
 *   手写配置规整后本插件零运行时依赖，从根上消除这类问题。
 *
 * 用法：node tools/drop-schemastery-dep.js   （在插件根目录执行）
 */

import fs from 'node:fs';

const FILE = 'lib/index.js';
let source = fs.readFileSync(FILE, 'utf8');
const before = source.length;

/* 1. 删掉 schemastery 的 import（按行过滤，比正则可靠） */
{
  const kept = source
    .split(/\r?\n/)
    .filter((line) => !(line.includes('schemastery') && /^\s*import\b/.test(line)));
  source = kept.join('\n');
}

/* 2. 用 normalizeConfig 替换整个 Config 块 */
const START = 'export const Config = z.object({';
const startAt = source.indexOf(START);
if (startAt < 0) throw new Error('找不到 Config 块起点');
const endAt = source.indexOf('\n});', startAt);
if (endAt < 0) throw new Error('找不到 Config 块终点');

const REPLACEMENT = `/**
 * 配置规整：手写，**不依赖 schemastery**。
 *
 * 先前用 schemastery 声明 Config，但本插件以 \`link:\` 装入 profile，
 * Node 解析不透「我的 node_modules → profile 的 node_modules → .dsh-module-fallback」
 * 这种多重 junction，导入时抛 \`Cannot find package 'schemastery'\`。
 * 而 Cordis 的加载器**先 import 再 apply** —— 导入失败会让
 * **整个 DSH 启动中断**（日志：\`Harness entry failed during startup\`）。
 * 手写规整后本插件零运行时依赖，从根上消除这类问题。
 *
 * 不导出 \`Config\`：Cordis 在没有 Config 时会把原始 config 原样交给 apply，
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
}`;

source = source.slice(0, startAt) + REPLACEMENT + source.slice(endAt + '\n});'.length);

/* 3. apply 里先规整配置 */
const APPLY_OLD = `export const apply = (ctx, config) => {
  const path = normalizePath(config.path);`;
const APPLY_NEW = `export const apply = (ctx, rawConfig) => {
  const config = normalizeConfig(rawConfig);
  const path = normalizePath(config.path);`;
if (!source.includes(APPLY_OLD)) throw new Error('找不到 apply 的开头');
source = source.replace(APPLY_OLD, APPLY_NEW);

/* 4. 默认导出改成 normalizeConfig */
const DEFAULT_OLD = 'export default { name, inject, Config, apply };';
const DEFAULT_NEW = 'export default { name, inject, normalizeConfig, apply };';
if (source.includes(DEFAULT_OLD)) source = source.replace(DEFAULT_OLD, DEFAULT_NEW);

/* 5. 兜底检查：只查真正的代码引用，别把注释里提到这个词也算上 */
const leftovers = [
  ...source.matchAll(/from\s+['"]schemastery['"]|\bz\.\w+\s*\(/g),
].map((m) => m[0]);
if (leftovers.length) throw new Error(`仍有残留引用: ${[...new Set(leftovers)].join(', ')}`);

fs.writeFileSync(FILE, source, 'utf8');
console.log(`已改写 ${FILE}：${before} → ${source.length} 字符`);
console.log('schemastery 依赖已彻底移除');
