/**
 * 把整个项目打成一个零依赖的单文件可执行程序（Node SEA）。
 *
 * 为什么用 SEA 而不是 pkg / nexe：Node 22+ 内置 node:sea，不需要额外装编译器，
 * 而且我们的依赖全是 Node 内置模块，所以可以真的做到「一个 exe 走天下」，
 * 目标机器连 Node.js 都不用装。
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const platformName = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
const extension = process.platform === 'win32' ? '.exe' : '';
const releaseDir = join(root, 'release', platformName);
const seaDir = join(root, 'dist', 'sea');
const bundlePath = join(seaDir, 'bundle.cjs');
const blobPath = join(seaDir, 'sea-prep.blob');
const executablePath = join(releaseDir, `bangumi-downloader${extension}`);
const postjectCli = join(root, 'node_modules', 'postject', 'dist', 'cli.js');

rmSync(releaseDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
mkdirSync(releaseDir, { recursive: true });
mkdirSync(seaDir, { recursive: true });

if (!hasSeaSentinel(process.execPath)) {
  console.error(
    [
      '',
      '错误：当前 Node 可执行文件里没有 SEA 哨兵（NODE_SEA_FUSE_...），无法注入应用。',
      `  当前 Node：${process.execPath}`,
      '',
      '常见原因：Homebrew 安装的 Node 以 --shared 方式构建，SEA 支持在动态库里，',
      '所以不能拿它当载体打单文件可执行程序。',
      '',
      '解决办法（任选其一）：',
      '  1) 换 nodejs.org 官方二进制（CI 用的就是它）：nvm install 22 && nvm use 22',
      '  2) 交给 GitHub Actions 出 Windows 包：推送 v* 标签，',
      '     .github/workflows/release.yml 会在 windows-latest 上构建并发布。',
      ''
    ].join('\n')
  );
  process.exit(1);
}

// 打包成单个 CJS 文件。SEA 只支持 CommonJS 入口，所以 format 固定为 cjs。
const result = await build({
  entryPoints: [join(root, 'src', 'bin.ts')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: bundlePath,
  // 依赖清单为空（只用 node: 内置模块），因此不需要 external。
  // 注意：这里不能加 "#!/usr/bin/env node" 横幅 —— SEA 是以 CJS 方式内嵌的，
  // 带 shebang 会让 embedderRunCjs 直接抛 SyntaxError。
  metafile: true
});

// 前端如果没构建，exe 里的页面只会显示一句提示。
// 主动检查一下，避免打出一个界面不可用的包。
const webBundlePath = join(root, 'src', 'web', 'generated', 'client-bundle.ts');
const webBundle = readFileSync(webBundlePath, 'utf8');
if (webBundle.includes('__CLIENT_NOT_BUILT__')) {
  console.error(
    '\n错误：前端资源尚未构建（src/web/generated/client-bundle.ts 还是占位内容）。' +
      '\n请先运行 npm run build:client，或直接运行 npm run build（它会先构建前端）。\n'
  );
  process.exit(1);
}

const bundledBytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0;
console.log(`打包完成：${(bundledBytes / 1024).toFixed(1)} KB`);

const seaConfigPath = join(seaDir, 'sea-config.json');
writeFileSync(
  seaConfigPath,
  JSON.stringify(
    {
      main: bundlePath,
      output: blobPath,
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false
    },
    null,
    2
  )
);

run(process.execPath, ['--experimental-sea-config', seaConfigPath]);

// 复制一份 node 作为载体。Homebrew 的 node 往往已经是单架构，
// 这时 lipo -thin 会报 "Non-fat file"，所以先探测再决定是否需要瘦身。
if (process.platform === 'darwin' && isFatBinary(process.execPath)) {
  run('lipo', ['-thin', process.arch, process.execPath, '-output', executablePath]);
} else {
  copyFileSync(process.execPath, executablePath);
}

// node 本体通常是 0555（只读），postject 无法写入，必须先把写权限加回来
chmodSync(executablePath, 0o755);

const postjectArgs = [
  postjectCli,
  executablePath,
  'NODE_SEA_BLOB',
  blobPath,
  '--sentinel-fuse',
  'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'
];
if (process.platform === 'darwin') postjectArgs.push('--macho-segment-name', 'NODE_SEA');
run(process.execPath, postjectArgs);

// macOS 上注入了 Mach-O 段之后必须重新签名，否则会被系统直接杀掉
if (process.platform === 'darwin') {
  run('codesign', ['--sign', '-', '--force', executablePath]);
}

// 随包附带配置文件模板、启动脚本和说明
copyFileSync(join(root, 'config.example.json'), join(releaseDir, 'config.example.json'));
copyFileSync(join(root, 'README.md'), join(releaseDir, 'README.md'));
if (process.platform === 'win32') {
  cpSync(join(root, 'packaging', 'windows'), releaseDir, { recursive: true });
  normalizeLineEndings(releaseDir);
}

// 无论在哪个平台构建都校验一次 Windows 脚本。
// 这些是跨平台的文本资源，错误应该在本机就暴露，而不是等用户双击才发现
// —— uninstall-startup.cmd 装错内容那件事就是这么溜进发行包的。
verifyPackaging(join(root, 'packaging', 'windows'));

console.log(`产物目录：${releaseDir}`);
console.log(`可执行文件：${executablePath}`);

function run(command, args, cwd = root) {
  execFileSync(command, args, { cwd, stdio: 'inherit' });
}

/**
 * 打包前的自检。
 *
 * 加这一段的起因是一个真实事故：uninstall-startup.cmd 里装的是 PowerShell 代码
 * （做中文名改名时把内容搞错了），于是那个脚本双击后每行都报错；
 * 同时它引用的 scripts/uninstall-startup.ps1 根本不存在 —— 两个问题都溜进了发行包。
 * 所以这里强制校验：.cmd 引用的 .ps1 必须存在，且 .cmd 里不能出现 PowerShell 语法。
 */
function verifyPackaging(directory) {
  const problems = [];

  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.cmd$/i.test(entry.name)) continue;

      const text = readFileSync(full, 'utf8');
      const relative = full.slice(directory.length + 1);

      // 1) 引用的 PowerShell 脚本必须存在
      for (const ref of text.matchAll(/scripts[/\\]([\w.-]+\.ps1)/g)) {
        const scriptPath = join(directory, 'scripts', ref[1]);
        if (!existsSync(scriptPath)) {
          problems.push(`${relative} 引用了不存在的 scripts/${ref[1]}`);
        }
      }

      // 2) .cmd 里出现 PowerShell 语法，几乎一定是内容放错了文件
      const psSyntax = /\$ErrorActionPreference|\$taskName|Register-ScheduledTask|Write-Host -ForegroundColor/;
      if (psSyntax.test(text)) {
        problems.push(`${relative} 里含有 PowerShell 代码，应该是内容放错了文件`);
      }

      // 3) 每个 .cmd 都应该有窗口标题，方便用户分辨
      if (!/^\s*title /m.test(text)) {
        problems.push(`${relative} 缺少 title，用户无法从窗口看出用途`);
      }
    }
  };

  walk(directory);

  if (problems.length > 0) {
    console.error('\nWindows 脚本自检未通过：');
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error('');
    process.exit(1);
  }

  const cmdCount = readdirSync(directory).filter((name) => /\.cmd$/i.test(name)).length;
  console.log(`Windows 脚本自检通过（${cmdCount} 个 .cmd，引用与标题均正常）`);
}

/**
 * 把 .cmd / .ps1 统一转成 CRLF。
 *
 * 仓库里这些文件是 LF（便于在 macOS/Linux 上编辑），但 Windows 的 cmd.exe
 * 在解析带括号的多行块时对纯 LF 支持不可靠，记事本看起来也会挤成一行。
 * 所以在打包这一步统一转换，而不是把 CRLF 提交进仓库。
 */
function normalizeLineEndings(directory) {
  let converted = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(cmd|bat|ps1)$/i.test(entry.name)) continue;
      const original = readFileSync(full, 'utf8');
      const normalized = original.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
      if (normalized !== original) {
        writeFileSync(full, normalized, 'utf8');
        converted += 1;
      }
    }
  };
  walk(directory);
  console.log(`已把 ${converted} 个脚本转换为 CRLF 换行`);
}

/** 判断一个 Mach-O 是否为含多架构的 fat 二进制。 */
function isFatBinary(path) {
  try {
    const info = execFileSync('lipo', ['-info', path], { encoding: 'utf8' });
    return /architecture:\s*\S+\s+\S+/.test(info) || info.includes('Architectures in the fat file');
  } catch {
    return false;
  }
}

/**
 * 载体 Node 里是否带 SEA 哨兵。
 * 用 --experimental-sea-config 生成 blob 时不需要哨兵，注入时才需要；
 * 提前检查可以给出比 postject 的 "Could not find the sentinel" 更清楚的原因。
 */
function hasSeaSentinel(nodePath) {
  try {
    const output = execFileSync('strings', ['-a', nodePath], { encoding: 'utf8', maxBuffer: 1024 * 1024 * 512 });
    return output.includes('NODE_SEA_FUSE');
  } catch {
    // 没有 strings 命令（例如 Windows）时不做判断，交给 postject 自己报错
    return true;
  }
}
