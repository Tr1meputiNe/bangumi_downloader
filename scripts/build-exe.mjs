/**
 * 把整个项目打成一个零依赖的单文件可执行程序（Node SEA）。
 *
 * 为什么用 SEA 而不是 pkg / nexe：Node 22+ 内置 node:sea，不需要额外装编译器，
 * 而且我们的依赖全是 Node 内置模块，所以可以真的做到「一个 exe 走天下」，
 * 目标机器连 Node.js 都不用装。
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
}

console.log(`产物目录：${releaseDir}`);
console.log(`可执行文件：${executablePath}`);

function run(command, args, cwd = root) {
  execFileSync(command, args, { cwd, stdio: 'inherit' });
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
