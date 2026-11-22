/**
 * dsh-install-guard — 装东西之前先体检。
 *
 * 四个机械动作，加一份讲清楚「什么时候该用、看到什么该停」的手册：
 *   inspect  大小 / SHA256 / 签名 / 下载标记 / 安装器格式 / 内嵌 URL 与 IP / 红旗串
 *   snapshot 计划任务 / 服务 / Run / Startup / WMI / 端口 / 外连 的基线
 *   diff     两份快照之间多出来什么，重点标出指向用户可写目录的条目
 *   sweep    按哈希（可带尺寸）全盘扫已知样本
 *
 * 三个重活由 ./scripts 里的 PowerShell 脚本干，这里只负责接线和把输出排成人话。
 * 全程只读：不删、不改、不装、不发请求。
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'install-guard';
export const inject = ['tools'];

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_DIR = path.join(HERE, 'scripts');
const GUIDE_FILE = path.join(HERE, 'GUIDE.md');
const PS_EXE = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { text: { type: 'string' } },
  required: ['text'],
};

const OUT = (text) => ({ text: String(text == null ? '' : text) });

function runScript(file, args, timeoutMs) {
  const full = path.join(SCRIPT_DIR, file);
  if (!fs.existsSync(full)) return Promise.resolve({ ok: false, error: '找不到脚本：' + full, stdout: '', stderr: '' });
  return new Promise((resolve) => {
    execFile(
      PS_EXE,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', full, ...args],
      { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) resolve({ ok: false, error: String(error.message || error), stdout: stdout || '', stderr: stderr || '' });
        else resolve({ ok: true, stdout: stdout || '', stderr: stderr || '' });
      },
    );
  });
}

// ------------------------------------------------------------------ 排版小工具

const pad = (n) => String(Math.max(0, Math.trunc(Number(n) || 0)));

function fmtSize(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 * 1024 * 1024) return (n / 1073741824).toFixed(2) + ' GB';
  if (n >= 1024 * 1024) return (n / 1048576).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(0) + ' KB';
  return n + ' 字节';
}

function fmtTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso || '');
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function dispWidth(text) {
  let width = 0;
  for (const ch of String(text)) {
    width += /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
  }
  return width;
}

function row(label, value, indent = 10) {
  return label + ' '.repeat(Math.max(1, indent - dispWidth(label))) + value;
}

function block(title) {
  return ['', '── ' + title + ' ' + '─'.repeat(Math.max(2, 26 - title.length * 2))];
}

// ------------------------------------------------------------------ inspect

const HEAD_BYTES = 16 * 1024 * 1024;
const TAIL_BYTES = 1024 * 1024;

function readRange(fd, offset, length) {
  const buf = Buffer.alloc(Math.max(0, length));
  if (length <= 0) return buf;
  let read = 0;
  try {
    read = fs.readSync(fd, buf, 0, length, offset);
  } catch {
    return buf.subarray(0, 0);
  }
  return buf.subarray(0, read);
}

function looksBinary(buf) {
  if (!buf.length) return false;
  const magic = buf.subarray(0, 8).toString('latin1');
  if (magic.startsWith('MZ') || magic.startsWith('MSCF') || magic.startsWith('\x7fELF')) return true;
  if (magic.startsWith('PK\x03\x04') || magic.startsWith('7z\xbc\xaf')) return true;
  const sample = buf.subarray(0, Math.min(4096, buf.length));
  let odd = 0;
  for (const byte of sample) {
    if (byte === 9 || byte === 10 || byte === 13) continue;
    if (byte < 9 || (byte > 13 && byte < 32)) odd += 1;
  }
  return odd / sample.length > 0.02;
}

function scanStrings(text) {
  const urls = new Set();
  for (const m of text.matchAll(/https?:\/\/[A-Za-z0-9\-._~:/#%+=?&]{4,90}/g)) urls.add(m[0]);
  const ips = new Set();
  for (const m of text.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)) {
    if (!/^(0\.|127\.|255\.|10\.|192\.168\.|169\.254\.)/.test(m[0])) ips.add(m[0]);
  }
  return { urls: [...urls], ips: [...ips] };
}

function signatureOf(file) {
  return new Promise((resolve) => {
    const cmd = `$s = Get-AuthenticodeSignature -LiteralPath '${String(file).replace(/'/g, "''")}'; ` +
      `"$($s.Status)|$($s.SignerCertificate.Subject)|$($s.SignerCertificate.Issuer)"`;
    execFile(PS_EXE, ['-NoProfile', '-NonInteractive', '-Command', cmd], { timeout: 30000, windowsHide: true }, (error, stdout) => {
      if (error) return resolve({ status: 'unknown', error: String(error.message || error) });
      const [status, subject, issuer] = String(stdout || '').trim().split('|');
      resolve({ status: status || 'unknown', subject: subject || '', issuer: issuer || '' });
    });
  });
}

function readMotw(file) {
  try {
    return fs.readFileSync(file + ':Zone.Identifier', 'utf8').trim();
  } catch {
    return '';
  }
}

async function inspectFile(target) {
  if (!target) return OUT('需要 path：要检查的文件的绝对路径');
  if (!fs.existsSync(target)) return OUT('找不到这个文件：' + target);

  const st = fs.statSync(target);
  const lines = ['━━ 安装前体检  inspect ━━'];
  lines.push(row('文件', target));
  lines.push(row('大小', fmtSize(st.size) + '（' + Number(st.size).toLocaleString('en-US') + ' 字节）'));
  lines.push(row('改动', fmtTime(st.mtime) + '   创建 ' + fmtTime(st.birthtime)));

  const sha256 = await new Promise((resolve, reject) => {
    const h = createHash('sha256');
    const rs = fs.createReadStream(target);
    rs.on('data', (chunk) => h.update(chunk));
    rs.on('error', reject);
    rs.on('end', () => resolve(h.digest('hex').toUpperCase()));
  });

  const motw = readMotw(target);
  const sig = await signatureOf(target);

  const fd = fs.openSync(target, 'r');
  let headBuf = Buffer.alloc(0);
  let headText = '';
  let tailText = '';
  try {
    headBuf = readRange(fd, 0, Math.min(HEAD_BYTES, st.size));
    headText = headBuf.toString('latin1');
    if (st.size > HEAD_BYTES) tailText = readRange(fd, Math.max(0, st.size - TAIL_BYTES), TAIL_BYTES).toString('latin1');
  } finally {
    fs.closeSync(fd);
  }

  const binary = looksBinary(headBuf);
  const text = headText + tailText;
  const marks = [
    ['NSIS', 'NullsoftInst'],
    ['Inno Setup', 'Inno Setup'],
    ['PyInstaller', 'PyInstaller'],
    ['Nuitka', 'Nuitka'],
    ['MSI cabinet', 'MSCF'],
    ['Electron', 'ELECTRON_RUN_AS_NODE'],
  ].filter(([, needle]) => text.includes(needle)).map(([label]) => label);

  const { urls, ips } = scanStrings(text);
  const flags = [
    'BOT DETECTION', 'telemetry', 'DisableBlockAtFirstSeen', 'Defender',
    'RDP Session', 'VirtualBox', 'vmware', 'qemu', 'sandbox',
    'Users\\Public', 'AppData\\Roaming', 'ProgramData', 'schtasks',
    'CreateService', 'reg add', 'FromBase64String',
  ].filter((word) => text.toLowerCase().includes(word.toLowerCase()));

  lines.push(...block('指纹'));
  lines.push(row('SHA256', sha256));
  const sigText = sig.error
    ? '查不出来（' + sig.error.slice(0, 60) + '）'
    : sig.status === 'Valid'
      ? '有效 · ' + (sig.subject || '（无主体）')
      : sig.status + (sig.subject ? ' · ' + sig.subject : '') + '（未签名或被改过）';
  lines.push(row('签名', sigText));
  lines.push(row('类型', binary ? '二进制' + (/^MZ/.test(headBuf.subarray(0, 2).toString('latin1')) ? ' · MZ/PE' : '') : '文本（跳过安装器与可疑串判断）'));
  if (binary) {
    lines.push(row('安装器', marks.length
      ? '是 · ' + marks.join(' / ')
      : sig.status === 'Valid'
        ? '没有安装器标记（带有效签名的程序通常本来就不是安装包）'
        : '没有已知安装器标记（可能是加壳、自解压或单文件程序）'));
  }
  lines.push(row('下载标记', motw ? '有 · ' + motw.split(/\r?\n/).slice(0, 4).join(' / ') : '没有（不是从浏览器下载的，或标记被清掉）'));

  lines.push(...block('内容'));
  if (urls.length) {
    lines.push(row('内嵌URL', String(urls.length) + ' 条'));
    urls.slice(0, 6).forEach((u) => lines.push(row('', '· ' + u)));
    if (urls.length > 6) lines.push(row('', '· 另 ' + (urls.length - 6) + ' 条没列'));
  } else {
    lines.push(row('内嵌URL', '0 条' + (binary ? '（可读范围内一个都没有，可能加壳了）' : '')));
  }
  lines.push(row('疑似IP', ips.length ? String(ips.length) + ' 个 · ' + ips.slice(0, 8).join(', ') + '（版本号里也长这样，别急着当证据）' : '0 个'));
  lines.push(row('可疑串', flags.length ? flags.join(' · ') : '没命中'));

  lines.push(...block('初判'));
  const verdict = [];
  if (sig.status === 'Valid') verdict.push('签名有效，签名人可查');
  else verdict.push('没有有效签名 —— 去跟官方公布的哈希对一下再说');
  if (binary && marks.length === 0 && st.size > 1024 * 1024) verdict.push('大体积又没有安装器标记，正经安装包很少这样');
  if (!binary) verdict.push('这是文本，别当二进制体检结论看');
  if (flags.some((f) => /BOT DETECTION|DisableBlockAtFirstSeen|telemetry/i.test(f))) verdict.push('命中了反分析/上报类字样，这类程序别给管理员');
  lines.push(row('结论', verdict.join('；')));
  lines.push('');
  lines.push('读法：哈希与官方公布值不一致 → 停手删掉；只说「杀软没报」不能当结论。');

  return OUT(lines.join('\n'));
}

// ------------------------------------------------------------------ snapshot

async function takeSnapshot(target) {
  const dir = path.join(os.tmpdir(), 'install-guard');
  fs.mkdirSync(dir, { recursive: true });
  const dest = target || path.join(dir, 'snapshot-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json');
  const res = await runScript('snapshot.ps1', ['-Out', dest], 180000);
  if (!res.ok) return OUT('基线没抓成：' + res.error + (res.stderr ? '\n' + res.stderr.slice(0, 1500) : ''));

  const counts = {};
  for (const m of res.stdout.matchAll(/(\w+)=(\d+)/g)) counts[m[1]] = Number(m[2]);
  const lines = ['━━ 基线已存  snapshot ━━'];
  lines.push(row('文件', dest));
  lines.push(row('规模', [
    '计划任务 ' + pad(counts.tasks),
    '服务 ' + pad(counts.services),
    '自启项 ' + pad((counts.run || 0) + (counts.startup || 0)),
    'WMI ' + pad(counts.wmi),
    '监听 ' + pad(counts.listen),
    '对外连接 ' + pad(counts.remote),
  ].join(' · ')));
  lines.push(row('下一步', '装完再抓一份，然后 diff 两份，看多出来什么'));
  return OUT(lines.join('\n'));
}

// ------------------------------------------------------------------ diff

const CAT_LABEL = {
  tasks: '计划任务',
  services: '服务',
  run: 'Run/RunOnce',
  startup: '启动文件夹',
  wmi: 'WMI 订阅',
  listen: '监听端口',
  remote: '对外连接',
  programfiles: 'Program Files 目录',
};

function formatDiff(raw) {
  const sections = [];
  const notes = [];
  let current = null;
  for (const line of raw.split(/\r?\n/)) {
    const head = line.match(/^=== (\w+) : \+(\d+) \/ -(\d+) ===$/);
    if (head) {
      current = { cat: head[1], plus: Number(head[2]), minus: Number(head[3]), items: [] };
      sections.push(current);
      continue;
    }
    if (/^### SUSPECT/.test(line)) {
      current = { cat: '__suspect', items: [] };
      sections.push(current);
      continue;
    }
    if (/^### no entry/.test(line)) {
      notes.push('没有指向用户可写目录的条目（干净）');
      current = null;
      continue;
    }
    const add = line.match(/^ {2}\+ (.+?) {2}-> {2}(.*)$/);
    const del = line.match(/^ {2}- (.+)$/);
    const sus = line.match(/^ {2}! (.+)$/);
    if (add && current) current.items.push({ sign: '+', key: add[1], action: add[2] });
    else if (del && current && !current.__suspect) current.items.push({ sign: '-', key: del[1], action: '' });
    else if (sus && current) current.items.push({ sign: '!', key: sus[1], action: '' });
  }

  const lines = ['━━ 差异  diff ━━'];
  const quiet = [];
  for (const s of sections) {
    if (s.cat === '__suspect') continue;
    const label = CAT_LABEL[s.cat] || s.cat;
    if (!s.plus && !s.minus) {
      quiet.push(label);
      continue;
    }
    lines.push('');
    lines.push(row(label, '新增 ' + s.plus + ' · 消失 ' + s.minus));
    for (const it of s.items) {
      const writable = /Public\\|\\Temp\\|AppData\\Local\\Temp|AppData\\Roaming|ProgramData/i.test(it.key + ' ' + it.action);
      lines.push(row('', '  ' + it.sign + ' ' + it.key + (it.action ? '  →  ' + it.action : '') + (writable ? '   ⚠ 用户可写' : '')));
    }
  }
  if (quiet.length) {
    lines.push('');
    lines.push(row('没变化', quiet.join(' · ')));
  }
  const suspect = sections.find((s) => s.cat === '__suspect');
  lines.push('');
  if (suspect && suspect.items.length) {
    lines.push(row('要看的', String(suspect.items.length) + ' 条指向用户可写目录：'));
    for (const it of suspect.items) lines.push(row('', '  ! ' + it.key));
  } else if (notes.length) {
    lines.push(row('结论', notes.join('；')));
  }
  return OUT(lines.join('\n').replace(/\n{3,}/g, '\n\n').trim());
}

async function diffSnapshots(before, after) {
  if (!before || !after) return OUT('需要 before 和 after 两个基线文件');
  if (!fs.existsSync(before)) return OUT('找不到 before：' + before);
  if (!fs.existsSync(after)) return OUT('找不到 after：' + after);
  const res = await runScript('diff-snapshot.ps1', ['-Before', before, '-After', after], 120000);
  if (!res.ok) return OUT('比对失败：' + res.error + (res.stderr ? '\n' + res.stderr.slice(0, 1500) : ''));
  return formatDiff(res.stdout);
}

// ------------------------------------------------------------------ sweep

async function sweep(hashes, sizes, roots) {
  if (!Array.isArray(hashes) || hashes.length === 0) return OUT('需要 hashes：至少给一个 SHA256');
  const args = ['-Hashes', hashes.join(',')];
  if (Array.isArray(sizes) && sizes.length) args.push('-Sizes', sizes.map((n) => String(Math.trunc(Number(n)))).join(','));
  if (Array.isArray(roots) && roots.length) args.push('-Roots', roots.join(','));

  const res = await runScript('sweep-hash.ps1', args, 1500000);
  if (!res.ok) return OUT('扫描没跑成：' + res.error + (res.stderr ? '\n' + res.stderr.slice(0, 1500) : ''));

  const hits = [...res.stdout.matchAll(/^HIT {2}(.+?) {2}\[(\d+)\] {2}(\w+)$/gm)].map((m) => ({ path: m[1], size: m[2], hash: m[3] }));
  const lines = ['━━ 哈希扫描  sweep ━━'];
  lines.push(row('哈希', hashes.length + ' 个' + (Array.isArray(sizes) && sizes.length ? ' · 尺寸预筛 ' + sizes.length + ' 个' : '')));
  lines.push(row('范围', Array.isArray(roots) && roots.length ? roots.join(' · ') : '默认 C:\\ 和 D:\\'));
  if (hits.length) {
    lines.push('');
    lines.push(row('命中', String(hits.length) + ' 处：'));
    for (const h of hits) lines.push(row('', '  ! ' + h.path + '  [' + fmtSize(h.size) + ']'));
    lines.push('');
    lines.push('命中说明这一批样本还在盘上，删之前先看创建时间和它的自启项。');
  } else {
    lines.push('');
    lines.push(row('结果', '0 命中 —— 这几个哈希在扫过的范围里没有文件'));
  }
  return OUT(lines.join('\n'));
}

function guide() {
  try {
    return OUT(fs.readFileSync(GUIDE_FILE, 'utf8').trim());
  } catch (error) {
    return OUT('读不到手册：' + String(error && error.message ? error.message : error));
  }
}

// ------------------------------------------------------------------ 插件本体

const PROMPT_TEXT = [
  '## 安装前的安全体检（install_guard）',
  '',
  '主人要装、部署、下载运行任何第三方东西（exe/msi/安装包、npm/pip 包、别人的仓库、浏览器扩展、别人发来的文件或脚本）之前，先调 `install_guard`，不要下载完就双击。',
  '',
  '顺序：',
  '1. `install_guard` action=inspect path=<下载下来的文件> — 看哈希、签名、安装器格式、内嵌 URL、红旗串。哈希与官方公布值对不上就别跑。',
  '2. 跑之前 `action=snapshot` 存基线，装完再 `action=snapshot`，然后 `action=diff` 比对：新出现的计划任务/服务/Run 项指向用户可写路径就是红的。',
  '3. 发现可疑落地物，`action=sweep` 按哈希全盘扫，同一批货会换名字藏在别处。',
  '4. 拿不准流程或要判读可疑点，`action=guide` 读完整清单。',
  '',
  '红旗（任一条就停手，把依据摆给主人）：反沙箱自检、上报用户名与公网 IP、改写 Defender 设置、复制成 C:\\Program Files 下的空壳服务、计划任务塞进微软目录、同一二进制换十几个名字、静默安装退出 0 却什么都没装。',
  '',
  '结论写人话：来源可不可核实、文件做了什么、需要删什么。别用「命中 T1053.005」这种话。',
].join('\n');

export function apply(ctx) {
  try {
    ctx.tools.register({
      name: 'install_guard',
      description:
        '安装/部署/运行任何第三方东西之前的体检工具。action=inspect 查一个下载文件（SHA256、签名、下载标记、安装器格式、内嵌 URL、红旗串）；action=snapshot 抓计划任务/服务/自启/端口基线；action=diff 比对两次基线并标出指向用户可写目录的新条目；action=sweep 按哈希（可带尺寸）全盘扫已知样本；action=guide 返回完整检查清单。只读，不删不改。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['inspect', 'snapshot', 'diff', 'sweep', 'guide'],
            description: '要做的检查。',
          },
          path: { type: 'string', description: 'inspect：要检查的文件绝对路径。' },
          out: { type: 'string', description: 'snapshot：基线写到哪，默认系统临时目录 install-guard 下。' },
          before: { type: 'string', description: 'diff：装之前那份基线。' },
          after: { type: 'string', description: 'diff：装之后那份基线。' },
          hashes: { type: 'array', items: { type: 'string' }, description: 'sweep：要扫的 SHA256。' },
          sizes: { type: 'array', items: { type: 'integer' }, description: 'sweep：可选的字节大小，给了就只哈希同尺寸文件，快很多。' },
          roots: { type: 'array', items: { type: 'string' }, description: 'sweep：扫哪些根目录，默认 C:\\ 和 D:\\。' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      timeoutMs: 1500000,
      output: {
        schema: OUTPUT_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: String((value && value.text) || '') }],
      },
      async execute(args = {}) {
        const action = String(args.action || '').trim();
        try {
          if (action === 'inspect') return await inspectFile(args.path);
          if (action === 'snapshot') return await takeSnapshot(args.out);
          if (action === 'diff') return await diffSnapshots(args.before, args.after);
          if (action === 'sweep') return await sweep(args.hashes, args.sizes, args.roots);
          if (action === 'guide') return guide();
          return OUT('action 只能是 inspect / snapshot / diff / sweep / guide');
        } catch (error) {
          return OUT('出错了：' + String(error && error.message ? error.message : error));
        }
      },
    });
  } catch (error) {
    ctx.logger?.warn?.('install-guard: 注册工具失败 ' + (error && error.message ? error.message : String(error)));
  }

  // 提示词段落是可选的：宿主没有 systemPrompt 服务就安静跳过。
  try {
    const systemPrompt = ctx.get?.('systemPrompt');
    if (systemPrompt && typeof systemPrompt.section === 'function') {
      systemPrompt.section({ name: 'install-guard', order: 60, text: () => PROMPT_TEXT });
    }
  } catch (error) {
    ctx.logger?.warn?.('install-guard: 跳过提示词段落 ' + (error && error.message ? error.message : String(error)));
  }
}
