/**
 * 备用打包方式：不依赖 SEA，产出一个「自带 node 运行时」的绿色目录。
 *
 * 什么时候需要它：如果将来 nodejs.org 的官方 Node 也不带 SEA 哨兵了，
 * 或者想在没有 Node 的 Windows 上跑一份可直接改代码的版本，
 * 这个脚本会复制一份 node.exe + 打包好的 bundle，效果等价。
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const platformName = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
const releaseDir = join(root, 'release', `${platformName}-portable`);
const runtimeName = process.platform === 'win32' ? 'node.exe' : 'node';

rmSync(releaseDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
mkdirSync(releaseDir, { recursive: true });

await build({
  entryPoints: [join(root, 'src', 'bin.ts')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: join(releaseDir, 'app.cjs'),
  banner: { js: '#!/usr/bin/env node' }
});

// 带上 Node 运行时，目标机器无需安装 Node
copyFileSync(process.execPath, join(releaseDir, runtimeName));
chmodSync(join(releaseDir, runtimeName), 0o755);

// 有些 Node 构建（例如 Homebrew 的 --shared 构建）把实现放在 libnode 动态库里，
// 光复制可执行文件是不够的，必须把非系统依赖一并带上并在启动脚本里指明查找路径。
const copiedLibs = copySharedLibs(releaseDir);

copyFileSync(join(root, 'config.example.json'), join(releaseDir, 'config.example.json'));
copyFileSync(join(root, 'README.md'), join(releaseDir, 'README.md'));

if (process.platform === 'win32') {
  writeFileSync(
    join(releaseDir, 'bangumi-downloader.cmd'),
    [
      '@echo off',
      'chcp 65001 >nul',
      'cd /d "%~dp0"',
      'set NODE_NO_WARNINGS=1',
      '"%~dp0node.exe" "%~dp0app.cjs" %*'
    ].join('\r\n')
  );
  cpSync(join(root, 'packaging', 'windows'), releaseDir, { recursive: true });
} else {
  const envPrefix = copiedLibs.length > 0 ? `export DYLD_LIBRARY_PATH="$(dirname "$0")/libs:$DYLD_LIBRARY_PATH"\n` : '';
  writeFileSync(
    join(releaseDir, 'bangumi-downloader'),
    ['#!/bin/sh', 'cd "$(dirname "$0")"', envPrefix + `exec "./${runtimeName}" ./app.cjs "$@"`].join('\n')
  );
  chmodSync(join(releaseDir, 'bangumi-downloader'), 0o755);
}

verify(join(releaseDir, process.platform === 'win32' ? 'bangumi-downloader.cmd' : 'bangumi-downloader'), [
  '--version'
]);
console.log(`绿色版产物目录：${releaseDir}`);
if (copiedLibs.length > 0) {
  console.log(`随包携带的动态库：${copiedLibs.join(', ')}`);
}

function verify(command, args) {
  const runner = process.platform === 'win32' ? 'cmd' : command;
  const finalArgs = process.platform === 'win32' ? ['/c', command, ...args] : args;
  execFileSync(runner, finalArgs, { cwd: releaseDir, stdio: 'inherit' });
}

/**
 * 把 Node 依赖的非系统动态库复制到 release/libs。
 * 只处理 macOS（otool）与 Linux（ldd）；Windows 的 node.exe 是静态链接，直接跳过。
 */
function copySharedLibs(targetDir) {
  if (process.platform === 'win32') return [];

  let listing;
  try {
    listing =
      process.platform === 'darwin'
        ? execFileSync('otool', ['-L', process.execPath], { encoding: 'utf8' })
        : execFileSync('ldd', [process.execPath], { encoding: 'utf8' });
  } catch {
    return [];
  }

  const libsDir = join(targetDir, 'libs');
  const copied = [];
  const seen = new Set();
  mkdirSync(libsDir, { recursive: true });

  const pending = [];
  for (const rawLine of listing.split('\n').slice(1)) {
    const match = /^\s+(\S+)\s+\(/.exec(rawLine) ?? /^\s+(\S+)\s+=>\s+(\S+)/.exec(rawLine);
    if (!match) continue;
    const libPath = process.platform === 'darwin' ? match[1] : match[2];
    if (libPath) pending.push(libPath);
  }

  // 依赖是传递的（libnode 依赖 libicuuc，libicuuc 又依赖 libicudata），
  // 所以沿着依赖图一直走下去，直到没有新的库为止。
  const nodeDir = dirname(process.execPath);
  while (pending.length > 0) {
    const entry = pending.shift();
    if (!entry) continue;

    const resolvedPath = resolveLibPath(entry, nodeDir, libsDir);
    if (resolvedPath === null) continue;
    if (seen.has(resolvedPath)) continue;
    seen.add(resolvedPath);

    const name = resolvedPath.split('/').pop();
    const destination = join(libsDir, name);
    try {
      copyFileSync(resolvedPath, destination);
      chmodSync(destination, 0o755);
      copied.push(name);
    } catch {
      continue;
    }

    // 展开这一层的依赖
    try {
      const nested =
        process.platform === 'darwin'
          ? execFileSync('otool', ['-L', resolvedPath], { encoding: 'utf8' })
          : execFileSync('ldd', [resolvedPath], { encoding: 'utf8' });
      for (const rawLine of nested.split('\n').slice(1)) {
        const match = /^\s+(\S+)\s+\(/.exec(rawLine) ?? /^\s+(\S+)\s+=>\s+(\S+)/.exec(rawLine);
        if (!match) continue;
        const nestedPath = process.platform === 'darwin' ? match[1] : match[2];
        if (nestedPath) pending.push(nestedPath);
      }
    } catch {
      // 展开失败就跳过，不影响已复制的部分
    }
  }

  if (process.platform === 'darwin' && copied.length > 0) rewriteInstallNames(libsDir, copied);
  return copied;
}

/**
 * 把一个依赖条目解析成真实存在的绝对路径。
 * @rpath 指的是 node 自身目录，@loader_path 指的是**引用方原本所在的目录**，
 * 所以 @loader_path/xxx 必须到该库原始目录的同级去找（Homebrew 的 ICU 就是这样互相引用的）。
 */
function resolveLibPath(entry, nodeDir, libsDir) {
  const isSystem = (path) => path.startsWith('/usr/lib/') || path.startsWith('/System/');

  if (!entry.startsWith('@')) {
    return entry.startsWith('/') && !isSystem(entry) ? entry : null;
  }

  const name = entry.split('/').pop();
  if (!name) return null;

  // 先在自己已经收集的库里找，再找 node 目录
  const direct = [join(libsDir, name), join(nodeDir, name), join(nodeDir, '..', 'lib', name)].find((candidate) =>
    existsSync(candidate)
  );
  if (direct) return realpathSync(direct);

  // 最后在 Homebrew / 常见库目录里按文件名兜底搜索
  const roots = ['/opt/homebrew/opt', '/opt/homebrew/lib', '/usr/local/opt', '/usr/local/lib'];
  for (const root of roots) {
    const found = findByBasename(root, name);
    if (found) return found;
  }
  return null;
}

/** 在指定目录下按文件名递归查找，最多下探 5 层，避免扫整个磁盘。 */
function findByBasename(root, name, depth = 0) {
  if (depth > 5 || !existsSync(root)) return null;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isFile() && entry.name === name) return realpathSync(full);
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = findByBasename(join(root, entry.name), name, depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * 把收集到的库之间的互相引用改成 @loader_path/xxx，
 * 这样它们在 libs/ 目录里就能互相找到，不依赖 Homebrew 的原始路径。
 */
function rewriteInstallNames(libsDir, copied) {
  for (const name of copied) {
    const target = join(libsDir, name);
    let listing;
    try {
      listing = execFileSync('otool', ['-L', target], { encoding: 'utf8' });
    } catch {
      continue;
    }
    for (const rawLine of listing.split('\n').slice(1)) {
      const match = /^\s+(\S+)\s+\(/.exec(rawLine);
      const dependency = match?.[1];
      if (!dependency || !dependency.startsWith('@')) continue;
      const dependencyName = dependency.split('/').pop();
      if (!copied.includes(dependencyName)) continue;
      try {
        execFileSync('install_name_tool', ['-change', dependency, `@loader_path/${dependencyName}`, target]);
      } catch {
        // 改不了就算了，DYLD_LIBRARY_PATH 还有一层兜底
      }
    }
  }
}
