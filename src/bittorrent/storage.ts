import { createHash } from 'node:crypto';
import { closeSync, existsSync, ftruncateSync, mkdirSync, openSync, readSync, statSync, writeSync } from 'node:fs';
import { basename, dirname, join, normalize, resolve, sep } from 'node:path';
import { pieceFileRanges, pieceSize, type TorrentMeta } from './metainfo.js';
import { logger } from '../util/log.js';

const log = logger('bt-storage');

/**
 * 落盘层。
 *
 * 设计取舍：
 *  - 打开文件句柄后用 pwrite 定位写，不维护跨 piece 的缓冲区，实现简单且不怕乱序到达；
 *  - 每个文件在开始时就 ftruncate 到目标长度（稀疏文件），这样中途查看也有正确体积；
 *  - 只对「需要的文件」分配与写入。选择下载时不需要的文件完全不落地，
 *    省磁盘也省 IO —— 这是「合集只取几集」场景的关键。
 */

export type StorageOptions = {
  /** 下载根目录。 */
  savePath: string;
  /** 只下载这些文件序号；为空表示全部。 */
  selectedFiles?: number[];
  /**
   * 单文件种子放进这个子目录（通常按发布名取一个番剧名）。
   *
   * 为什么需要：多文件种子本身带目录结构（种子里的 name），天然一部一番。
   * 但单集种子是「一个文件」，照原样落盘就会散在下载根目录里，
   * 和别的番剧的文件夹混在一起 —— 实测一个单集 mp4 就那样躺在根下。
   * 给了这个字段，单集也会有自己的番剧目录。
   */
  singleFileDir?: string;
  /** 所有番剧文件夹的统一父目录（例如「番剧」），让内容与程序/缓存分开。 */
  seriesRoot?: string;
};

export type FileHandleEntry = {
  index: number;
  path: string;
  absolutePath: string;
  length: number;
  selected: boolean;
  fd: number | null;
};

export class TorrentStorage {
  readonly meta: TorrentMeta;
  readonly savePath: string;
  readonly files: FileHandleEntry[];
  readonly pieceLength: number;
  /** 已校验通过的 piece。 */
  readonly verified = new Set<number>();
  #bytesWritten = 0;
  #closed = false;

  constructor(meta: TorrentMeta, options: StorageOptions) {
    this.meta = meta;
    this.pieceLength = meta.pieceLength;
    this.savePath = resolve(options.savePath);

    const seriesRoot = options.seriesRoot?.trim();

    const selected = options.selectedFiles && options.selectedFiles.length > 0 ? new Set(options.selectedFiles) : null;

    /*
     * 目录归纳：一部番一个文件夹，所有番剧文件夹再统一放到 seriesRoot 下。
     *
     *   多文件种子：用种子自带的 name（本来就是一个目录）
     *   单文件种子：用调用方给的番剧名（否则会散在根目录里）
     */
    const root = seriesRoot ? join(this.savePath, sanitizeSegment(seriesRoot)) : this.savePath;
    const folderName = meta.singleFile
      ? sanitizeSegment(options.singleFileDir ?? meta.name)
      : sanitizeSegment(meta.name);
    const base = join(root, folderName);

    this.files = meta.files.map((file) => {
      const relative = sanitizeRelativePath(file.path);
      // 单文件种子：文件名就是 info.name，直接放根目录，不再套一层
      const absolutePath = meta.singleFile
        ? join(base, basename(relative) || sanitizeSegment(meta.name))
        : join(base, relative);
      return {
        index: file.index,
        path: file.path,
        absolutePath,
        length: file.length,
        selected: selected === null ? true : selected.has(file.index),
        fd: null
      };
    });

    for (const entry of this.files) {
      if (!entry.selected || entry.length === 0) continue;
      mkdirSync(dirname(entry.absolutePath), { recursive: true });
      entry.fd = openSync(entry.absolutePath, existsSync(entry.absolutePath) ? 'r+' : 'w+');
    }

    // 预分配成目标长度（稀疏），避免下到一半文件体积看起来不对
    for (const entry of this.files) {
      if (entry.fd === null) continue;
      try {
        const current = statSync(entry.absolutePath).size;
        if (current < entry.length) ftruncateSync(entry.fd, entry.length);
      } catch {
        // 预分配失败不影响后续写入
      }
    }
  }

  /** 本次实际会写的字节数。 */
  get selectedBytes(): number {
    let total = 0;
    for (const file of this.meta.files) {
      const entry = this.files[file.index];
      if (entry?.selected) total += file.length;
    }
    return total;
  }

  get bytesWritten(): number {
    return this.#bytesWritten;
  }

  /** 需要下载的 piece 序号（只统计覆盖到选中文件的那些）。 */
  wantedPieces(): number[] {
    const wanted: number[] = [];
    for (let index = 0; index < this.meta.pieceCount; index += 1) {
      if (this.pieceTouchesSelection(index)) wanted.push(index);
    }
    return wanted;
  }

  /** 该 piece 是否覆盖到至少一个选中的文件。 */
  pieceTouchesSelection(pieceIndex: number): boolean {
    const ranges = pieceFileRanges(this.meta, pieceIndex);
    if (ranges.length === 0) return false;
    return ranges.some((range) => this.files[range.fileIndex]?.selected === true);
  }

  /**
   * 校验一个 piece 的 SHA1。
   * 校验不通过时返回 false，调用方应当把该 piece 重新排队。
   */
  verify(pieceIndex: number, data: Uint8Array): boolean {
    const expected = this.meta.pieceHashes[pieceIndex];
    if (!expected) return false;
    if (data.length !== pieceSize(this.meta, pieceIndex)) return false;
    const hash = createHash('sha1').update(data).digest();
    return hash.equals(Buffer.from(expected));
  }

  /** 把校验通过的 piece 写到对应文件位置。 */
  writePiece(pieceIndex: number, data: Uint8Array): void {
    if (this.#closed) throw new Error('存储已关闭');
    const ranges = pieceFileRanges(this.meta, pieceIndex);
    let cursor = 0;

    for (const range of ranges) {
      const entry = this.files[range.fileIndex];
      const chunk = data.subarray(cursor, cursor + range.length);
      cursor += range.length;
      if (!entry || entry.fd === null || !entry.selected) continue;
      try {
        writeSync(entry.fd, chunk, 0, chunk.length, range.fileOffset);
        this.#bytesWritten += chunk.length;
      } catch (error) {
        log.warn(`写入 ${entry.absolutePath} 失败：${(error as Error).message}`);
        throw error;
      }
    }

    this.verified.add(pieceIndex);
  }

  /**
   * 启动时扫描已有数据：把磁盘上已经完整且校验通过的 piece 标记出来，
   * 这样断点续传时不会重下已经有的部分。
   */
  resumeScan(): number {
    let reused = 0;

    for (let index = 0; index < this.meta.pieceCount; index += 1) {
      if (!this.pieceTouchesSelection(index)) continue;
      const size = pieceSize(this.meta, index);
      const buffer = Buffer.alloc(size);
      const ranges = pieceFileRanges(this.meta, index);
      let cursor = 0;
      let complete = true;

      for (const range of ranges) {
        const entry = this.files[range.fileIndex];
        if (!entry || entry.fd === null || !entry.selected) {
          complete = false;
          break;
        }
        let read = 0;
        try {
          read = readSync(entry.fd, buffer, cursor, range.length, range.fileOffset);
        } catch {
          complete = false;
          break;
        }
        if (read !== range.length) {
          complete = false;
          break;
        }
        cursor += range.length;
      }

      if (!complete) continue;
      const hash = createHash('sha1').update(buffer).digest();
      const expected = this.meta.pieceHashes[index];
      if (expected && hash.equals(Buffer.from(expected))) {
        this.verified.add(index);
        reused += 1;
      }
    }

    return reused;
  }

  /** 已选文件的绝对路径列表（用于报告「下到了哪」）。 */
  selectedPaths(): string[] {
    return this.files.filter((entry) => entry.selected).map((entry) => entry.absolutePath);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const entry of this.files) {
      if (entry.fd === null) continue;
      try {
        closeSync(entry.fd);
      } catch {
        // 关闭失败无需处理
      }
      entry.fd = null;
    }
  }
}

/** 去掉路径里对 Windows 非法的字符，避免 mkdir 直接失败。 */
export function sanitizeSegment(name: string): string {
  // 控制字符是有意要替换掉的（Windows 文件名不允许），所以这里必须匹配它们
  // eslint-disable-next-line no-control-regex
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').slice(0, 120) || 'torrent';
}

/** 规范化种子内部的相对路径，挡掉 ../ 这类越界。 */
export function sanitizeRelativePath(path: string): string {
  const parts = normalize(path)
    .split(/[\\/]+/)
    .filter((part) => part.length > 0 && part !== '.' && part !== '..');
  return parts.map(sanitizeSegment).join(sep);
}
