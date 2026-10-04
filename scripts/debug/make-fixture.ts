/**
 * 造一个「像真的一样」的下载库，用来在本机点一遍界面上的每个按钮。
 * 内容包含：一个下完的多文件种子、一个空壳、一个本地内容目录。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function bencode(node: unknown): Buffer {
  const parts: Buffer[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === 'number') return void parts.push(Buffer.from(`i${value}e`));
    if (typeof value === 'string') {
      const bytes = Buffer.from(value, 'utf8');
      return void parts.push(Buffer.from(`${bytes.length}:`), bytes);
    }
    if (Buffer.isBuffer(value)) return void parts.push(Buffer.from(`${value.length}:`), value);
    if (Array.isArray(value)) {
      parts.push(Buffer.from('l'));
      for (const item of value) walk(item);
      return void parts.push(Buffer.from('e'));
    }
    if (typeof value === 'object' && value !== null) {
      parts.push(Buffer.from('d'));
      for (const [key, item] of Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        walk(key);
        walk(item);
      }
      parts.push(Buffer.from('e'));
    }
  };
  walk(node);
  return Buffer.concat(parts);
}

const root = process.argv[2] ?? '/tmp/bd-fixture';
rmSync(root, { recursive: true, force: true });

const seriesRoot = join(root, '番剧');
const metaDir = join(root, '.bangumi-meta');
mkdirSync(metaDir, { recursive: true });

const PIECE = 32768;

function makeTorrent(name: string, files: Array<{ path: string; length: number }>, fill: number) {
  const total = files.reduce((sum, file) => sum + file.length, 0);
  const data = Buffer.alloc(total, fill);
  const pieces: Buffer[] = [];
  for (let offset = 0; offset < total; offset += PIECE) {
    pieces.push(createHash('sha1').update(data.subarray(offset, Math.min(offset + PIECE, total))).digest());
  }
  const infoBytes = bencode({
    name,
    'piece length': PIECE,
    pieces: Buffer.concat(pieces),
    files: files.map((file) => ({ length: file.length, path: file.path.split('/') }))
  });
  const infoHash = createHash('sha1').update(infoBytes).digest('hex');
  writeFileSync(join(metaDir, `${infoHash}.bin`), infoBytes);
  return { data, total };
}

// 1) 下完的一季（3 集）
const complete = makeTorrent(
  '[BDrip] Fixture Show S01 [1080p]',
  [
    { path: '01.mkv', length: PIECE },
    { path: '02.mkv', length: PIECE },
    { path: '03.mkv', length: PIECE }
  ],
  7
);
const completeDir = join(seriesRoot, '[BDrip] Fixture Show S01 [1080p]');
mkdirSync(completeDir, { recursive: true });
for (const [index, name] of ['01.mkv', '02.mkv', '03.mkv'].entries()) {
  writeFileSync(join(completeDir, name), complete.data.subarray(index * PIECE, (index + 1) * PIECE));
}
writeFileSync(join(completeDir, 'subtitle.ass'), '[Script Info]\nTitle: fixture\n');

// 2) 空壳：文件长度对，内容全是零
const shell = makeTorrent('[WebRip] Fixture Shell - 01', [{ path: '01.mkv', length: PIECE * 2 }], 3);
const shellDir = join(seriesRoot, '[WebRip] Fixture Shell - 01');
mkdirSync(shellDir, { recursive: true });
writeFileSync(join(shellDir, '01.mkv'), Buffer.alloc(shell.total, 0));

// 3) 下到一半
const half = makeTorrent('[BDrip] Fixture Half S02', [{ path: '01.mkv', length: PIECE * 2 }], 5);
const halfDir = join(seriesRoot, '[BDrip] Fixture Half S02');
mkdirSync(halfDir, { recursive: true });
writeFileSync(join(halfDir, '01.mkv'), Buffer.concat([half.data.subarray(0, PIECE), Buffer.alloc(PIECE, 0)]));

// 4) 用户自己下的（本地内容）
const localDir = join(seriesRoot, '[Airota] Fixture Movie [BDRip]');
mkdirSync(localDir, { recursive: true });
writeFileSync(join(localDir, 'movie.mkv'), Buffer.alloc(4096, 1));

// 5) 程序目录（应当被忽略）
mkdirSync(join(root, 'bangumi-downloader'), { recursive: true });
writeFileSync(join(root, 'bangumi-downloader', 'bangumi-downloader.exe'), 'fake');

// 6) 日志文件，界面上能看
mkdirSync(join(root, 'data'), { recursive: true });
writeFileSync(
  join(root, 'data', 'bangumi.log'),
  [
    '[2026-01-01 20:15:00] INFO  [run] 本轮结束：番剧 3 部，未看 5 集',
    '[2026-01-01 20:15:02] INFO  [bt] 开始下载：[BDrip] Fixture Show S01',
    '[2026-01-01 20:19:31] WARN  [bt] 有 12 个 tracker 无返回',
    '[2026-01-01 20:24:44] INFO  [jobs] 任务完成：job-1',
    '[2026-01-01 20:25:00] ERROR [web] 请求处理失败：模拟一条错误日志'
  ].join('\n') + '\n',
  'utf8'
);

// 7) 追番清单
writeFileSync(
  join(root, 'watchlist.json'),
  `${JSON.stringify(
    {
      version: 1,
      entries: [
        { query: 'Fixture Show 第一季', lastEpisode: 3, startFrom: 1, completedEpisodes: [1, 2, 3], note: '本机固定装置' },
        { query: 'Fixture Half 第二季', lastEpisode: 0, note: '下到一半' },
        { query: '停掉的番', enabled: false }
      ]
    },
    null,
    2
  )}\n`,
  'utf8'
);

// 8) 配置
writeFileSync(
  join(root, 'config.json'),
  `${JSON.stringify(
    {
      web: { port: 3778, host: '127.0.0.1', openBrowser: false },
      download: { backend: 'builtin', savePath: root, seriesDir: '番剧', readyDelayMinutes: 60 },
      qbittorrent: { password: 'fixture-password' },
      plannerBaseUrl: 'http://127.0.0.1:9',
      trackers: { mikan: false }
    },
    null,
    2
  )}\n`,
  'utf8'
);

console.log(`固定装置已生成：${root}`);
