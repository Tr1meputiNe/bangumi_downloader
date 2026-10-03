/**
 * 构建前端：把 src/web/client/ 打包成两个纯文本产物，
 * 放进 src/web/generated/，然后再由 build-exe 通过 esbuild 的 text loader
 * 内联进服务端 bundle。
 *
 * 产物是「默认导出一段字符串的 .ts 模块」，这样：
 *  - build-exe 打包服务端时，esbuild 会把这两个模块直接内联进 bundle
 *  - 开发时 tsx 能直接加载它们，不需要额外的 loader
 * 用 .ts 而不是 .txt 是被 tsx 逼的：Node 不认识 .txt 扩展名会直接抛
 * ERR_UNKNOWN_FILE_EXTENSION，而 .ts 本来就是这套工具链的一等公民。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const generatedDir = join(root, 'src', 'web', 'generated');
const distDir = join(root, 'dist', 'web');

mkdirSync(generatedDir, { recursive: true });
mkdirSync(distDir, { recursive: true });

// 前端所有代码（含 preact/htm）打进一个 IIFE，不需要任何外部依赖
const result = await build({
  entryPoints: [join(root, 'src', 'web', 'client', 'app.ts')],
  bundle: true,
  platform: 'browser',
  target: ['es2020'],
  format: 'iife',
  minify: true,
  outfile: join(distDir, 'client.js'),
  loader: { '.ts': 'ts' },
  legalComments: 'none',
  metafile: true
});

// preact 的 jsx-runtime 会按需引入，这里确认没有把 node 内置模块带进来
const inputs = Object.keys(result.metafile.inputs);
const leaked = inputs.filter((path) => path.startsWith('node:'));
if (leaked.length > 0) {
  throw new Error(`前端误引入了 node 内置模块，浏览器里会崩：${leaked.join(', ')}`);
}

const jsBytes = readFileSync(join(distDir, 'client.js'));
const jsText = jsBytes.toString('utf8');

// 写成一个可被 esbuild text loader 导入的模块：默认导出一段字符串。
// 用 JSON.stringify 生成，保证引号、换行、模板字符串都被正确转义。
writeFileSync(
  join(generatedDir, 'client-bundle.ts'),
  `/**\n * 由 scripts/build-client.mjs 生成，请勿手工编辑。\n * 内容是打包好的前端 bundle；服务端在运行时把它内联进 HTML。\n */\nexport default ${JSON.stringify(jsText)};\n`,
  'utf8'
);

// CSS 直接读源码（没有预处理器，不需要打包步骤）
const css = readFileSync(join(root, 'src', 'web', 'client', 'style.css'), 'utf8');
writeFileSync(
  join(generatedDir, 'client-style.ts'),
  `/**\n * 由 scripts/build-client.mjs 生成，请勿手工编辑。\n */\nexport default ${JSON.stringify(css)};\n`,
  'utf8'
);

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;
console.log(`前端构建完成：client.js ${kb(jsBytes.length)}，client.css ${kb(Buffer.byteLength(css))}`);

// 顺手做一次类型检查，前端也走严格 TS
try {
  execFileSync(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit'], {
    cwd: root,
    stdio: 'inherit'
  });
} catch {
  throw new Error('前端构建后类型检查未通过');
}
