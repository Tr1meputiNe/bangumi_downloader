import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { extname } from 'node:path';

/**
 * 判断一个视频文件「看起来能不能播」。
 *
 * 为什么需要：这个项目按断点续传设计，文件一开始就被预分配到完整长度。
 * 于是**文件大小完全不能反映内容** —— 一个 700MB 的 mkv 可能里面全是零。
 * 实测踩过两次：一次是 13 个看着齐整的 mkv 其实全是空壳；一次是用别的下载器
 * 留下的半成品，文件大小对得上、播放器打开就报错。
 *
 * 这里的判据全部来自文件内容本身，不看文件系统给的任何元数据：
 *   1. 容器魔数对不对（MKV 的 EBML、MP4 的 ftyp、AVI 的 RIFF）
 *   2. MP4 的 moov 索引在不在（没有 moov 就没法 seek，很多播放器直接拒绝）
 *   3. 从头/中/尾抽样，看有没有实际数据（全是零 = 预分配的空壳）
 */

export type ContainerKind = 'mkv' | 'webm' | 'mp4' | 'avi' | 'unknown';

export type PlayabilityIssue =
  /** 容器魔数不对，或不认识的格式 */
  | 'bad-container'
  /** MP4 缺 moov 索引 */
  | 'missing-moov'
  /** 抽样全是零，没有任何实际数据 */
  | 'empty'
  /** 数据量极少（低于 1%），几乎可以确定没下完 */
  | 'sparse'
  /** 读不到文件 */
  | 'unreadable';

export type VideoCheck = {
  path: string;
  sizeBytes: number;
  container: ContainerKind;
  /** 抽样区域里非零字节的占比（0~1）。 */
  dataRatio: number;
  issues: PlayabilityIssue[];
  /** 没有任何致命问题。注意这不等于「内容完整」，只等于「结构上像能播」。 */
  playable: boolean;
};

const HEAD_BYTES = 64 * 1024;
/** 每个采样窗口最多读多少（窗口宽度按文件大小自适应，不超过这个值）。 */
const MAX_WINDOW_BYTES = 4 * 1024 * 1024;
/*
 * 判定的分层，全部用**绝对字节数**而不是比例：
 *
 *   头部之外非零 < 4KB   -> empty  （只有魔数，典型预分配空壳）
 *   头部之外非零 < 1MB   -> sparse （确实有数据，但少得可疑）
 *   否则                 -> 不报问题
 *
 * 为什么不用比例：采样量随文件大小变化（16 个窗口 × min(1MB, size/16)），
 * 大文件上采样占比很小，比例阈值会失灵。绝对量更直观也更稳。
 */
/** 头部之外少于这么多非零字节，就认为只是空壳（魔数之外什么都没有）。 */
const EMPTY_DATA_BYTES = 4 * 1024;
/**
 * 头部之外少于这么多非零字节，认为「有数据但大概率没下完」。
 *
 * 取 256KB 是个折中：一个真正下过一段数据的文件，随便采几个窗口就能拿到
 * 远超这个量；而刚开头就断掉的半成品通常只有几十 KB。
 */
const SPARSE_DATA_BYTES = 256 * 1024;
/** 兼容旧引用。 */
const MIN_DATA_BYTES = EMPTY_DATA_BYTES;
/** 填充率低于这个值才判定为「几乎肯定没下完」。 */
const SPARSE_RATIO = 0.01;

export function isVideoFile(path: string): boolean {
  return ['.mkv', '.mp4', '.avi', '.webm', '.m4v', '.mov'].includes(extname(path).toLowerCase());
}

/** 检查一个视频文件。任何异常都收敛成 issue，不往外抛。 */
export function checkVideoFile(path: string): VideoCheck {
  const result: VideoCheck = {
    path,
    sizeBytes: 0,
    container: 'unknown',
    dataRatio: 0,
    issues: [],
    playable: false
  };

  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    result.issues.push('unreadable');
    return result;
  }
  result.sizeBytes = size;

  if (size === 0) {
    result.issues.push('empty');
    return result;
  }

  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    result.issues.push('unreadable');
    return result;
  }

  try {
    const head = Buffer.alloc(Math.min(HEAD_BYTES, size));
    const headRead = readSync(fd, head, 0, head.length, 0);
    result.container = detectContainer(head.subarray(0, headRead));

    if (result.container === 'unknown') {
      result.issues.push('bad-container');
    }

    // MP4：moov 是索引，缺了就没法正常播放/拖动（很多播放器直接报错）
    if (result.container === 'mp4' && !hasMoov(fd, size, head.subarray(0, headRead))) {
      result.issues.push('missing-moov');
    }

    /*
     * 区分「全空」和「只有文件头」。
     *
     * 只看非零率会漏掉最坑的那种文件：头部有合法的 EBML/ftyp 魔数，
     * 因此非零率不严格为 0，看着像「有一点数据」；但魔数之后全是零 ——
     * 也就是预分配出来的空壳。实测就是被这种文件骗过一次
     * （13 个 700MB 的 mkv，剥掉文件头后一个字节都没有）。
     */
    const sample = sampleData(fd, size);
    result.dataRatio = sample.ratio;
    const dataOutsideHeader = sample.nonzero - sample.nonzeroInHead;

    if (sample.nonzero === 0 || dataOutsideHeader < EMPTY_DATA_BYTES) {
      // 头部之外没有数据 —— 典型的「预分配空壳」，只有魔数是真内容
      result.issues.push('empty');
    } else if (dataOutsideHeader < SPARSE_DATA_BYTES) {
      /*
       * 有数据，但少得可疑。
       *
       * 这个判断刻意保守：我们并不知道文件本该有多大，所以只在
       * 「采样到的真实数据不到 1MB」时才说「可能没下完」，
       * 并在措辞上留有余地。误报比不报更糟 —— 会让人不再相信报告。
       */
      result.issues.push('sparse');
    }
  } catch {
    result.issues.push('unreadable');
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* 忽略 */
    }
  }

  result.playable = !result.issues.some((issue) => issue === 'bad-container' || issue === 'empty' || issue === 'unreadable');
  return result;
}

function detectContainer(head: Buffer): ContainerKind {
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
    // EBML 头的 DocType 决定是 matroska 还是 webm
    return head.includes(Buffer.from('webm')) ? 'webm' : 'mkv';
  }
  if (head.length >= 12 && head.subarray(4, 8).toString('latin1') === 'ftyp') return 'mp4';
  if (head.length >= 4 && head.subarray(0, 4).toString('latin1') === 'RIFF') return 'avi';
  return 'unknown';
}

/** moov 通常在文件开头；不在开头时去尾部找（faststart 与否的差别）。 */
function hasMoov(fd: number, size: number, head: Buffer): boolean {
  if (head.includes(Buffer.from('moov'))) return true;
  if (size <= head.length) return false;

  const tailLength = Math.min(1024 * 1024, size - head.length);
  const tail = Buffer.alloc(tailLength);
  try {
    const read = readSync(fd, tail, 0, tailLength, size - tailLength);
    return tail.subarray(0, read).includes(Buffer.from('moov'));
  } catch {
    return false;
  }
}

/**
 * 抽样统计非零字节。
 *
 * 沿文件均匀取 16 处、每处 64KB（约 1MB 采样量，对几百 MB 的文件是毫秒级）。
 * 早先用 4 个固定点，结果漏掉了「只在中间某处写过一点数据」的文件，
 * 把没下完的误判成空壳 —— 采样点太少会骗人。
 *
 * 额外区分「位于文件头部的非零」和「头部之外的非零」：前者可能只是魔数。
 */
function sampleData(fd: number, size: number): { total: number; nonzero: number; nonzeroInHead: number; ratio: number } {
  /*
   * 采样窗口的宽度必须 >= 步长，否则窗口之间存在空隙，
   * 落在空隙里的数据会被完全漏掉 —— 这不是理论问题：
   * 16 个 1MB 窗口铺在 32MB 文件上时，步长 2.16MB、空隙 1.1MB，
   * 一个写在中间的 128KB 数据块正好掉进空隙，被判成「空壳」。
   *
   * 现在取 8 个窗口，宽度 = min(4MB, 文件大小/8)，步长 = (size - width)/7，
   * 保证 width >= stride，也就是**任何连续数据都不可能整段落在空隙里**。
   * 代价是每个文件最多读 32MB；verify 里本来就要为分片校验读全盘，这点开销可以接受。
   */
  const SAMPLES = 8;
  const windowBytes = Math.max(64 * 1024, Math.min(MAX_WINDOW_BYTES, Math.ceil(size / SAMPLES)));
  const span = Math.max(1, size - windowBytes);
  const offsets: number[] = [];
  for (let i = 0; i < SAMPLES; i += 1) {
    const offset = Math.floor((span * i) / (SAMPLES - 1));
    offsets.push(Math.max(0, Math.min(offset, span)));
  }
  const unique = [...new Set(offsets)];

  let total = 0;
  let nonzero = 0;
  let nonzeroInHead = 0;

  for (const offset of unique) {
    const length = Math.min(windowBytes, size - offset);
    if (length <= 0) continue;
    const buffer = Buffer.alloc(length);
    let read = 0;
    try {
      read = readSync(fd, buffer, 0, length, offset);
    } catch {
      continue;
    }
    for (let i = 0; i < read; i += 1) {
      if (buffer[i] === 0) continue;
      nonzero += 1;
      if (offset + i < HEAD_BYTES) nonzeroInHead += 1;
    }
    total += read;
  }

  return { total, nonzero, nonzeroInHead, ratio: total === 0 ? 0 : nonzero / total };
}

/** 给人看的一句话结论。 */
export function describeIssue(issue: PlayabilityIssue): string {
  switch (issue) {
    case 'bad-container':
      return '文件头不是认识的视频格式，播放器多半打不开';
    case 'missing-moov':
      return 'MP4 缺少 moov 索引，无法正常播放/拖动';
    case 'empty':
      return '内容全是零（预分配出来的空壳），播不了';
    case 'sparse':
      return '数据量很少，可能没下完';
    case 'unreadable':
      return '文件读不到';
  }
}

export { EMPTY_DATA_BYTES, SPARSE_DATA_BYTES, MIN_DATA_BYTES, MAX_WINDOW_BYTES, SPARSE_RATIO };
