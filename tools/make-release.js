/**
 * make-release.js — 用 GitHub REST API 建 Release 并上传 npm tarball
 *
 * 为什么用 REST API 而不是 gh CLI / git push tag：
 *   本机 github.com:443 会间歇性连不通（git push 走的入口，实测每 2~3 次失败一次），
 *   而 api.github.com 与 uploads.github.com 稳定可用。
 *
 * 为什么把 .tgz 当附件：
 *   npm 发布还卡着（token 缺 bypass 2FA 权限），把 npm pack 的产物挂到 Release 上，
 *   别人可以直接 `npm install ./dsh-wechat-channel-<版本>.tgz` 装上，不必等 npm。
 *
 * 凭据从 git credential manager 现取，只在内存里用，不落盘不打印。
 *
 * 用法：
 *   npm pack                       # 先产出 .tgz
 *   node tools/make-release.js --dry-run
 *   node tools/make-release.js
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'Shr-CS/dsh-wechat-channel';
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const TAG = 'v' + VERSION;
const NAME = `dsh-wechat-channel ${TAG}`;
const TGZ = path.join(ROOT, `dsh-wechat-channel-${VERSION}.tgz`);
const DRY = process.argv.includes('--dry-run');

const NOTES = [
  `## dsh-wechat-channel ${TAG}`,
  '',
  '微信公众号通道插件：**在微信里发指令操控 DeepSeek Harness，并把结果推回微信。**',
  '',
  '零运行时依赖（只用 Node 内置的 `fetch`/`crypto`/`http`），只声明一个 `@deepseek-ai/cordis` peerDependency。',
  '',
  '### 工作方式',
  '',
  '```',
  '微信 App ──发消息──▶ 腾讯服务器 ──HTTPS 回调──▶ cloudflared 隧道 ──▶ 本插件',
  '                                                                      │',
  '                                          ① 立刻被动回复「已收到」（≤5 秒）',
  '                                          ② 后台跑 DSH 会话（可能几分钟）',
  '                                          ③ 客服消息接口把结果推回微信',
  '```',
  '',
  '### 安装',
  '',
  '**方式一：用下面这个 .tgz（不需要等 npm）**',
  '',
  '```bash',
  `npm install ./dsh-wechat-channel-${VERSION}.tgz`,
  '# 或者让 DSH 直接从解压后的目录加载',
  '# dsh plugin --profile web add link:<解压出的绝对路径>',
  '```',
  '',
  '**方式二：从 GitHub 仓库**',
  '',
  '```bash',
  'git clone https://github.com/Shr-CS/dsh-wechat-channel.git',
  'dsh plugin --profile web add link:<克隆下来的绝对路径>',
  '```',
  '',
  '装完需要**重启 `dsh web`** 才会加载（`patchReload: live` 只管补丁层，不管新包）。',
  '',
  '### 配置',
  '',
  '在 `<DSH_HOME>/profiles/web/cordis.patch.yml` 里：',
  '',
  '```yaml',
  '- id: wechat',
  '  config:',
  '    token: 你自定的一个字符串        # 必须与公众号后台填的 Token 一致',
  '    appId: wx********                # 测试号的 appID（异步回复必需）',
  '    appSecret: ********',
  '    path: /wechat-mp                 # 刻意避开 /wechat，见下',
  '    allowFrom: []                    # openid 白名单，空=全部拒绝',
  '    requireWhitelist: true',
  '```',
  '',
  '### ⚠️ 两个实测踩到的坑',
  '',
  '1. **包名不能叫 `dsh-wechat`** —— npm 上已有同名第三方包。DSH 的插件世代系统按名字解析依赖，',
  '   你的 `link:` 会在插件恢复时被替换成 `.generations/live/dsh-wechat+<版本>` 的 junction，',
  '   加载的就不是你这份代码了。本包因此命名 `dsh-wechat-channel`。',
  '2. **路由不能占用 `/wechat/status`** —— 那个第三方包注册了 `/wechat/qr` 与 `/wechat/status`，',
  '   而 DSH 的 webserver 对重复路由**直接抛错**，会让本插件的 effect 整体失败、**静默不激活**。',
  '   本插件用独立前缀 `/wechat-mp`，两者可以共存。',
  '',
  '### 硬约束：微信回调必须公网可达',
  '',
  '回调用腾讯的服务器发起，**不是你的手机**。所以局域网内手机和电脑同一个 WiFi 没有任何用。',
  '只想要「手机控制 DSH」且只在局域网内，请用 `@linxin666/dsh-remote-web-ui` 的手机浏览器方案。',
  '',
  '### 测试',
  '',
  '```bash',
  'npm test    # 82 项：签名排序、CDATA 注入、白名单、5 秒死线、token 缓存与并发去重、',
  '            #        失效重试、长文分条、每用户串行、超时取消、会话淘汰，以及完整异步链路',
  '```',
  '',
  '### 安全模型',
  '',
  '**配对设备 = 完全控制凭据。** DSH 的 agent 能执行命令、读写文件，而本插件把它暴露到公网。',
  '`allowFrom` 白名单是唯一准入控制，回调入口有 SHA1 签名校验（定长比较，错误一律 403），',
  '状态端点需要 `?key=<token>` 且绝不回显 token。',
].join('\n');

/* ------------------------------------------------------------------ */

function gitCredential() {
  return new Promise((resolve) => {
    const p = execFile('git', ['credential', 'fill'], { timeout: 30000 }, (err, stdout) => {
      if (err) return resolve(null);
      const f = {};
      for (const line of String(stdout).split('\n')) {
        const i = line.indexOf('=');
        if (i > 0) f[line.slice(0, i)] = line.slice(i + 1);
      }
      resolve(f);
    });
    p.stdin.end('protocol=https\nhost=github.com\n\n');
  });
}

function api(method, url, token, { json, raw, contentType, timeout = 1800000 } = {}) {
  return new Promise((resolve, reject) => {
    const args = [
      '-s', '-w', '\n%{http_code}',
      '-X', method,
      '-H', 'Authorization: Bearer ' + token,
      '-H', 'User-Agent: dsh-release',
      '-H', 'Accept: application/vnd.github+json',
    ];
    if (json !== undefined) args.push('-H', 'Content-Type: application/json', '-d', JSON.stringify(json));
    if (raw !== undefined) {
      if (contentType) args.push('-H', 'Content-Type: ' + contentType);
      args.push('--data-binary', raw);
    }
    args.push(url.startsWith('http') ? url : 'https://api.github.com' + url);
    execFile('curl.exe', args, { timeout, maxBuffer: 1 << 26 }, (err, stdout) => {
      const text = String(stdout || '');
      const nl = text.lastIndexOf('\n');
      if (err) return reject(new Error(`curl 失败(${text.slice(nl + 1).trim()}): ${err.message}`));
      resolve({ code: Number(text.slice(nl + 1).trim()), body: text.slice(0, nl) });
    });
  });
}

if (!fs.existsSync(TGZ)) {
  console.error('找不到 ' + TGZ);
  console.error('请先执行：npm pack');
  process.exit(1);
}
const kb = (fs.statSync(TGZ).size / 1024).toFixed(1);

const cred = await gitCredential();
if (!cred?.password) { console.error('拿不到 GitHub 凭据'); process.exit(1); }
const token = cred.password;
console.log(`凭据: ${cred.username} / token 前缀 ${token.slice(0, 4)}…（不落盘）`);
console.log(`仓库: ${REPO}`);
console.log(`版本: ${VERSION}   tag: ${TAG}`);
console.log(`附件: ${path.basename(TGZ)}  ${kb} KB`);
console.log('');

const repo = await api('GET', `/repos/${REPO}`, token);
if (repo.code !== 200) { console.error('读仓库失败 HTTP ' + repo.code); process.exit(1); }
const perms = JSON.parse(repo.body).permissions || {};
console.log('仓库权限: ' + JSON.stringify(perms));
if (!perms.push && !perms.admin) { console.error('token 无写权限'); process.exit(1); }

const head = await api('GET', `/repos/${REPO}/commits/main`, token);
if (head.code === 200) console.log('main HEAD: ' + JSON.parse(head.body).sha.slice(0, 7));

const existing = await api('GET', `/repos/${REPO}/releases/tags/${TAG}`, token);
if (existing.code === 200) {
  console.log(`\n已存在 ${TAG} 的 Release：${JSON.parse(existing.body).html_url}`);
  console.log('不做任何修改。要重发请先在网页上删除它。');
  process.exit(0);
}
console.log(`tag ${TAG} 暂无 Release（HTTP ${existing.code}），可以创建。`);

if (DRY) {
  console.log('\n--dry-run：检查通过，未创建任何东西。');
} else {
  console.log('\n创建 Release ...');
  const created = await api('POST', `/repos/${REPO}/releases`, token, {
    json: { tag_name: TAG, target_commitish: 'main', name: NAME, body: NOTES, draft: false, prerelease: false },
  });
  if (created.code !== 201) {
    console.error(`创建失败 HTTP ${created.code}: ${created.body.slice(0, 500)}`);
    process.exit(1);
  }
  const rel = JSON.parse(created.body);
  console.log(`✓ Release 已创建：${rel.html_url}`);

  const assetName = path.basename(TGZ);
  const url = `https://uploads.github.com/repos/${REPO}/releases/${rel.id}/assets?name=${encodeURIComponent(assetName)}`;
  console.log(`\n上传附件 ${assetName} ...`);
  const up = await api('POST', url, token, { raw: '@' + TGZ, contentType: 'application/gzip' });
  if (up.code !== 201) {
    console.error(`上传失败 HTTP ${up.code}: ${up.body.slice(0, 400)}`);
    console.error(`Release 已建好，可手动把 ${assetName} 拖到 ${rel.html_url}`);
    process.exit(1);
  }
  const asset = JSON.parse(up.body);
  console.log(`✓ ${asset.name}  ${(asset.size / 1024).toFixed(1)} KB`);
  console.log(`  ${asset.browser_download_url}`);
  console.log(`\n完成 → ${rel.html_url}`);
}
