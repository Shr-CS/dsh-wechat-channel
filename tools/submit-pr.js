/**
 * submit-pr.js — 把本插件投稿到 awesome-dsh-plugin 精选目录
 *
 *   fork 上游仓库 → 建分支 → 写 data/plugins/<owner>__<repo>.yml → 开 PR
 *
 * 全流程走 GitHub REST API，不用 gh CLI、不用 git push：
 *   本机 github.com:443 会间歇性连不通（git push 走的入口），
 *   而 api.github.com 稳定可用。
 *
 * 为什么要等到第二天：投稿指南要求仓库「创建满 1 天」，由 CI 自动检查。
 * 脚本会自己读仓库创建时间，没满 24 小时就拒绝执行并退出 —— 免得白提一次。
 *
 * 用法：
 *   node tools/submit-pr.js --check      # 只看当前是否够条件，不做任何修改
 *   node tools/submit-pr.js --dry-run    # 检查 + 打印将要提交的内容，仍不修改
 *   node tools/submit-pr.js              # 真提交
 *
 * 幂等：已经开过 PR 就跳过，不会重复开。
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const UPSTREAM = 'awesome-dsh-plugin/awesome-dsh-plugin';
const MY_REPO = 'Shr-CS/dsh-wechat-channel';
const OWNER = 'Shr-CS';
const ENTRY_FILE = 'data/plugins/Shr-CS__dsh-wechat-channel.yml';
const BRANCH = 'add-dsh-wechat-channel';
const LOCAL_ENTRY = path.join(ROOT, 'submit-entry.yml');
const LOG = path.join(ROOT, 'tools', 'submit-pr.log');

const MODE = process.argv.includes('--dry-run') ? 'dry-run'
  : process.argv.includes('--check') ? 'check'
  : process.argv.includes('--stage') ? 'stage'
  : 'submit';

const AGE_BAR_HOURS = 24;

const lines = [];
function say(text = '') {
  console.log(text);
  lines.push(text);
}
function finish(code) {
  try { fs.writeFileSync(LOG, `[${new Date().toISOString()}] mode=${MODE}\n` + lines.join('\n') + '\n', 'utf8'); } catch { }
  process.exit(code);
}

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

/** 调 API；网络抖动自动重试（github 在本机不稳） */
async function api(method, url, token, { json, tries = 6 } = {}) {
  let last = null;
  for (let n = 1; n <= tries; n++) {
    const args = ['-s', '-w', '\n%{http_code}', '-X', method,
      '-H', 'Authorization: Bearer ' + token,
      '-H', 'User-Agent: dsh-submit-pr',
      '-H', 'Accept: application/vnd.github+json'];
    let bodyFile = null;
    if (json !== undefined) {
      bodyFile = path.join(ROOT, 'tools', '.submit-body.json');
      fs.writeFileSync(bodyFile, JSON.stringify(json), 'utf8');
      args.push('-H', 'Content-Type: application/json', '--data-binary', '@' + bodyFile);
    }
    args.push(url.startsWith('http') ? url : 'https://api.github.com' + url);

    const res = await new Promise((resolve) => {
      execFile('curl.exe', args, { timeout: 120000, maxBuffer: 1 << 26 }, (err, stdout) => {
        const text = String(stdout || '');
        const nl = text.lastIndexOf('\n');
        resolve({ err, code: Number(text.slice(nl + 1).trim()), body: text.slice(0, nl) });
      });
    });
    if (bodyFile) fs.rmSync(bodyFile, { force: true });

    if (!res.err && Number.isFinite(res.code) && res.code > 0) return res;
    last = res;
    say(`  · 第 ${n} 次请求失败（${res.err?.message?.split('\n')[0] || 'HTTP ' + res.code}），5 秒后重试`);
    await new Promise((r) => setTimeout(r, 5000));
  }
  return last ?? { code: 0, body: '' };
}

const j = (res) => { try { return JSON.parse(res.body); } catch { return null; } };

/* ------------------------------------------------------------------ */

const cred = await gitCredential();
if (!cred?.password) { say('拿不到 GitHub 凭据（git credential fill 无返回）'); finish(1); }
const token = cred.password;
say(`凭据: ${cred.username}  模式: ${MODE}`);
say('');

// 1) 仓库年龄自检 —— 这是最容易被 CI 打回的一项
const mine = await api('GET', `/repos/${MY_REPO}`, token);
if (mine.code !== 200) { say(`读自己的仓库失败 HTTP ${mine.code}`); finish(1); }
const repoInfo = j(mine);
const created = new Date(repoInfo.created_at);
const ageHours = (Date.now() - created.getTime()) / 3600000;
const eligible = new Date(created.getTime() + AGE_BAR_HOURS * 3600000);

say('=== 仓库年龄自检（CI 硬性门槛：满 24 小时）===');
say(`  创建时间 : ${created.toISOString()}`);
say(`  已存在   : ${ageHours.toFixed(1)} 小时`);
say(`  门槛时间 : ${eligible.toISOString()}  (北京时间 ${new Date(eligible.getTime() + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ')})`);

if (ageHours < AGE_BAR_HOURS) {
  const wait = ((eligible.getTime() - Date.now()) / 3600000).toFixed(1);
  if (MODE === 'stage') {
    // --stage 只做 fork/分支/写文件，不开 PR，所以不触发 CI 的年龄检查。
    // 提前把这些做掉，正式提交那天就只剩最后一步，风险最小。
    say(`  ⚠ 未满 ${AGE_BAR_HOURS} 小时（还需 ${wait} 小时），但 --stage 不开 PR，不触发 CI，继续。`);
  } else {
    say(`  ❌ 还不满 ${AGE_BAR_HOURS} 小时，还需等待 ${wait} 小时 —— 现在提交会被 CI 直接拒，本次不做任何操作。`);
    finish(2);
  }
} else {
  say('  ✅ 已满 24 小时');
}
say('');

// 2) 本地投稿内容
if (!fs.existsSync(LOCAL_ENTRY)) { say(`找不到投稿文件 ${LOCAL_ENTRY}`); finish(1); }
const entryYaml = fs.readFileSync(LOCAL_ENTRY, 'utf8');
say('=== 将要写入 ' + ENTRY_FILE + ' 的内容 ===');
say(entryYaml.trimEnd());
say('');

if (MODE === 'check') { say('--check：只检查，不做任何修改。'); finish(0); }
if (MODE === 'dry-run') { say('--dry-run：不创建 fork、不建分支、不开 PR。'); finish(0); }

// 3) 已经开过 PR 就不再开
const q = await api('GET', `/repos/${UPSTREAM}/pulls?state=all&head=${OWNER}:${BRANCH}`, token);
const existing = j(q);
if (Array.isArray(existing) && existing.length) {
  say(`已经开过 PR，跳过：#${existing[0].number}  ${existing[0].html_url}`);
  say(`  状态: ${existing[0].state}${existing[0].merged_at ? '（已合并）' : ''}`);
  finish(0);
}
say('上游暂无本分支的 PR，继续。');

// 4) 确保 fork 存在
say('');
say('=== 1/5 准备 fork ===');
let fork = j(await api('GET', `/repos/${OWNER}/${UPSTREAM.split('/')[1]}`, token));
if (!fork || fork.message === 'Not Found') {
  say('  fork 不存在，正在创建...');
  const made = await api('POST', `/repos/${UPSTREAM}/forks`, token, { json: { default_branch_only: true } });
  if (made.code !== 202 && made.code !== 200) { say(`  创建 fork 失败 HTTP ${made.code}: ${made.body.slice(0, 200)}`); finish(1); }
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 4000));
    fork = j(await api('GET', `/repos/${OWNER}/${UPSTREAM.split('/')[1]}`, token));
    if (fork && fork.id) break;
  }
  if (!fork || !fork.id) { say('  fork 创建后迟迟没就绪，稍后重试'); finish(1); }
  say(`  ✅ fork 就绪：${fork.full_name}`);
} else {
  say(`  fork 已存在：${fork.full_name}`);
}

// 尽量让 fork 追上上游，避免 PR 基于过期的 main
const up = await api('POST', `/repos/${fork.full_name}/merge-upstream`, token, { json: { branch: fork.default_branch } });
say(`  merge-upstream: HTTP ${up.code}${up.code === 200 ? ' ✅' : '（忽略，不阻塞）'}`);

// 5) 决定用哪个分支当 PR 的 head
//
// 两种现实情况都要兼容：
//   a) 条目文件已经在 fork 的默认分支（main）上 —— 例如在 GitHub 网页上
//      「Create new file」默认就提交到 main。那就直接拿 main 开 PR。
//   b) main 上还没有 —— 新建一个专用分支，把文件写进去。
say('');
say('=== 2/5 准备 head 分支 ===');
const headRef = j(await api('GET', `/repos/${fork.full_name}/git/ref/heads/${fork.default_branch}`, token));
if (!headRef?.object?.sha) { say('  拿不到 fork 的 HEAD，放弃'); finish(1); }
say(`  ${fork.default_branch} HEAD = ${headRef.object.sha.slice(0, 7)}`);

const onDefault = await api('GET', `/repos/${fork.full_name}/contents/${ENTRY_FILE}?ref=${fork.default_branch}`, token);
let HEAD_BRANCH;
if (onDefault.code === 200) {
  HEAD_BRANCH = fork.default_branch;
  say(`  ✅ 条目文件已在 ${fork.default_branch} 上，直接用它当 head（不新建分支）`);
} else {
  HEAD_BRANCH = BRANCH;
  const existingRef = await api('GET', `/repos/${fork.full_name}/git/ref/heads/${BRANCH}`, token);
  if (existingRef.code === 200) {
    say(`  分支 ${BRANCH} 已存在，复用`);
  } else {
    const made = await api('POST', `/repos/${fork.full_name}/git/refs`, token,
      { json: { ref: `refs/heads/${BRANCH}`, sha: headRef.object.sha } });
    if (made.code !== 201) { say(`  建分支失败 HTTP ${made.code}: ${made.body.slice(0, 200)}`); finish(1); }
    say(`  ✅ 已建分支 ${BRANCH}`);
  }
}

// 6) 确保条目文件内容与本地一致
say('');
say('=== 3/5 写入/校正条目文件 ===');
const fileApi = `/repos/${fork.full_name}/contents/${ENTRY_FILE}`;
const cur = await api('GET', `${fileApi}?ref=${HEAD_BRANCH}`, token);
const wantB64 = Buffer.from(entryYaml, 'utf8').toString('base64');
if (cur.code === 200) {
  const have = j(cur);
  if (have.sha === undefined) { say('  读不到文件 sha，放弃'); finish(1); }
  // base64 里可能带换行，去掉空白再比
  const same = have.size === Buffer.byteLength(entryYaml, 'utf8')
    && String(have.content).replace(/\s/g, '') === wantB64.replace(/\s/g, '');
  if (same) {
    say(`  ✅ ${HEAD_BRANCH} 上已有同名文件且内容一致（sha ${have.sha.slice(0, 7)}），不动它`);
  } else {
    const put = await api('PUT', fileApi, token, {
      json: { message: 'Update Shr-CS/dsh-wechat-channel entry', content: wantB64, branch: HEAD_BRANCH, sha: have.sha },
    });
    if (put.code !== 200 && put.code !== 201) { say(`  更新文件失败 HTTP ${put.code}: ${put.body.slice(0, 300)}`); finish(1); }
    say(`  ✅ 已更新为本地内容（HTTP ${put.code}）`);
  }
} else {
  const put = await api('PUT', fileApi, token, {
    json: { message: 'Add Shr-CS/dsh-wechat-channel (WeChat Official Account channel)', content: wantB64, branch: HEAD_BRANCH },
  });
  if (put.code !== 200 && put.code !== 201) { say(`  写文件失败 HTTP ${put.code}: ${put.body.slice(0, 300)}`); finish(1); }
  say(`  ✅ 已新建 ${ENTRY_FILE}（HTTP ${put.code}）`);
}

// 7) 开 PR
if (MODE === 'stage') {
  say('');
  say('=== 4/5 开 PR —— 已跳过（--stage）===');
  say(`  head 分支 ${HEAD_BRANCH} 与条目文件都已就绪。`);
  say('  正式提交时再跑一次不带 --stage 的同名命令即可。');
  say(`  手动开 PR 的地址：https://github.com/${UPSTREAM}/compare/main...${OWNER}:${HEAD_BRANCH}?expand=1`);
  finish(0);
}

say('');
say('=== 4/5 开 PR ===');
const prBody = [
  'Adds one entry: `data/plugins/Shr-CS__dsh-wechat-channel.yml`.',
  '',
  '**Note on overlap with existing WeChat entries.** Every WeChat entry currently on the list',
  "bridges through Tencent's iLink bot protocol, which requires a separately-run daemon logged",
  'into a personal WeChat account. This plugin uses the WeChat **Official Account (公众号)**',
  'channel instead: HTTPS callbacks with SHA1 signature verification for inbound messages, and',
  "the customer-service message API for replies. No third-party daemon, no personal account.",
  '',
  'Checklist against the requirements in contributing.md:',
  '',
  '- `package.json` declares `dsh.bundle.patch` → `./cordis.patch.yml` (present at the repo root)',
  '- Real, working code: `lib/` is five modules, `npm test` runs 82 assertions',
  '- `dsh-plugin` topic added',
  '- `@deepseek-ai/cordis` is a `peerDependencies` entry, not a `dependencies` entry',
  '- A prebuilt tarball is attached to the v0.1.1 release and referenced via the `tarball:` field',
  '',
  'No npm package yet (a publish token problem on my side) — the `tarball:` field covers it.',
].join('\n');

const pr = await api('POST', `/repos/${UPSTREAM}/pulls`, token, {
  json: { title: 'Add Shr-CS/dsh-wechat-channel (WeChat Official Account channel)', head: `${OWNER}:${HEAD_BRANCH}`, base: 'main', body: prBody, maintainer_can_modify: true },
});
if (pr.code !== 201) {
  say(`  开 PR 失败 HTTP ${pr.code}: ${pr.body.slice(0, 400)}`);
  say(`  可手动开 PR：https://github.com/${UPSTREAM}/compare/main...${OWNER}:${HEAD_BRANCH}?expand=1`);
  finish(1);
}
const pull = j(pr);
say('');
say('=== 5/5 完成 ===');
say(`✅ PR #${pull.number}  ${pull.html_url}`);
say(`   状态: ${pull.state}   可编辑: ${pull.maintainer_can_modify}`);
finish(0);
