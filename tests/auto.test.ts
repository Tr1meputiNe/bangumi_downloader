import { describe, expect, it } from 'vitest';
import { selectWantedEpisodes } from '../src/core/auto.js';
import { isPaddingFile } from '../src/bittorrent/downloader.js';
import { markEpisodesCompleted, loadWatchlist, saveWatchlist } from '../src/core/watchlist.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 这些用例对应的都是真实踩过的坑，不是假想场景：
 *   - start 缺省漏成 undefined -> 整季被判成「没有新集」，静默不下（最难发现的一个）
 *   - 半集被当成已完成 -> 用户以为下好了，播放才发现是半集
 *   - BitComet 填充文件被当正片下 -> 白下几 MB 垃圾
 */

describe('selectWantedEpisodes', () => {
  const available = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);

  it('没追过任何一集时，整季都要下', () => {
    const wanted = selectWantedEpisodes({ available, completed: new Set(), start: 1, limit: 999 });
    expect(wanted).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  });

  it('start 非法时退回 1（这是曾经导致「一条都不下」的那个 bug）', () => {
    for (const bad of [undefined, null, 0, -1, Number.NaN] as unknown[]) {
      const wanted = selectWantedEpisodes({
        available,
        completed: new Set(),
        start: bad as number,
        limit: 999
      });
      expect(wanted.length, `start=${String(bad)} 时不应为空`).toBe(13);
    }
  });

  it('已下完的集不会重复挑', () => {
    const wanted = selectWantedEpisodes({
      available,
      completed: new Set([1, 2, 3]),
      start: 1,
      limit: 999
    });
    expect(wanted).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  });

  it('limit 生效且按集号升序', () => {
    const wanted = selectWantedEpisodes({ available, completed: new Set([1]), start: 1, limit: 3 });
    expect(wanted).toEqual([2, 3, 4]);
  });
});

describe('markEpisodesCompleted', () => {
  it('只把真正下完的集记成已完成，并且不推进到缺集之后', () => {
    const dir = mkdtempSync(join(tmpdir(), 'watchlist-'));
    const path = join(dir, 'watchlist.json');
    try {
      saveWatchlist(path, { version: 1, entries: [{ query: '测试番' }] });

      // 只下完 1、2 和 5：lastEpisode 只能推进到 2，不能因为有了 5 就当成追到 5
      markEpisodesCompleted(path, '测试番', [1, 2, 5]);
      const entry = loadWatchlist(path).entries[0];
      expect(entry?.completedEpisodes).toEqual([1, 2, 5]);
      expect(entry?.lastEpisode).toBe(2);

      // 补上 3、4 之后，连续段推到 5
      markEpisodesCompleted(path, '测试番', [3, 4]);
      expect(loadWatchlist(path).entries[0]?.lastEpisode).toBe(5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('isPaddingFile', () => {
  it('识别 BitComet 的对齐填充文件', () => {
    expect(isPaddingFile('_____padding_file_3_如果您看到此文件，请升级到BitComet(比特彗星)0.85或以上版本____')).toBe(true);
    expect(isPaddingFile('padding_file_0')).toBe(true);
    expect(isPaddingFile('CD1/[Comicat] 第01集.mp4')).toBe(false);
    expect(isPaddingFile('Hibike Euphonium S03E01.mkv')).toBe(false);
  });
});
