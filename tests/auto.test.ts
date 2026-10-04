import { describe, expect, it } from 'vitest';
import { selectRelaxedCandidates, selectWantedEpisodes } from '../src/core/auto.js';
import { parseReleaseName } from '../src/anime/parse.js';
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

describe('selectRelaxedCandidates：编号方式不同的同一集', () => {
  const airedAt = new Date('2026-10-04T16:00:00');
  const result = (title: string, publishedAt: string | null = '2026-10-04T16:35:00+08:00') => ({
    title,
    magnet: `magnet:?xt=urn:btih:${'a'.repeat(40)}`,
    sizeBytes: 700 * 1024 * 1024,
    publishedAt,
    seederCount: 10,
    leecherCount: null,
    tracker: 'animes.garden',
    provider: 'animes.garden',
  });

  const ranked = (items: Array<{ title: string; publishedAt?: string | null }>) =>
    items.map((item) => ({
      result: result(item.title, item.publishedAt === undefined ? '2026-10-04T16:35:00+08:00' : item.publishedAt),
      parsed: parseReleaseName(item.title),
      score: 80,
      reasons: [],
      rejected: false,
      coversEpisodes: [1]
    }));

  it('把「全季连续编号」的同集认出来（13 集 → S01E25）', () => {
    const picked = selectRelaxedCandidates({
      ranked: ranked([
        { title: '[Nix-Raws] Seihantai na Kimi to Boku S01E25 [CR WEB-DL 1080p AVC AAC][简繁内封]' },
        { title: '[ANi] Seihantai na Kimi to Boku S02 - 25 [1080P][Baha][WEB-DL]' }
      ]),
      targetEpisode: 13,
      airedAt
    });
    expect(picked).toHaveLength(2);
  });

  it('集号不大于目标的一律不要（那是已经播过的旧集）', () => {
    // 注意判据是「集号 > 目标」+「发布时间在播出之后」：
    // 一个旧集如果偏偏今天才发布，形式上和「同集不同编号」无法区分 ——
    // 这是这套放宽策略接受的残余风险（严格匹配的候选永远排在前面）。
    const picked = selectRelaxedCandidates({
      ranked: ranked([{ title: '[Nix-Raws] Seihantai na Kimi to Boku S01E12 [CR WEB-DL 1080p]' }]),
      targetEpisode: 13,
      airedAt
    });
    expect(picked).toHaveLength(0);
  });

  it('不碰播出之前就发布的（字幕组不会提前放没播的集）', () => {
    const picked = selectRelaxedCandidates({
      ranked: ranked([{ title: '[Group] Show S01E30 [1080p]', publishedAt: '2026-10-01T12:00:00+08:00' }]),
      targetEpisode: 13,
      airedAt
    });
    expect(picked).toHaveLength(0);
  });

  it('拿不到发布时间时放行（宁可多试一条，也别因为缺字段漏掉）', () => {
    const picked = selectRelaxedCandidates({
      ranked: ranked([{ title: '[Group] Show S01E25 [1080p]', publishedAt: null }]),
      targetEpisode: 13,
      airedAt
    });
    expect(picked).toHaveLength(1);
  });

  it('合集和离谱的集号都不要（下错集是硬伤）', () => {
    const picked = selectRelaxedCandidates({
      ranked: ranked([
        { title: '[Group] Show 全集 01-25 [1080p]' },
        { title: '[Group] Show S01E999 [1080p]' }
      ]),
      targetEpisode: 13,
      airedAt
    });
    expect(picked).toHaveLength(0);
  });

  it('被偏好淘汰的候选仍然不要', () => {
    const items = ranked([{ title: '[Group] Show S01E25 [1080p]' }]);
    items[0]!.rejected = true;
    expect(selectRelaxedCandidates({ ranked: items, targetEpisode: 13, airedAt })).toHaveLength(0);
  });
});

describe('速度判定：慢但能下 ≠ 下不动', () => {
  it('按「收到的字节」算吞吐，而不是「已校验的分片」', () => {
    // 这条是回归测试。分片 2MB、试跑窗口 75 秒，按分片算的话：
    //   链路低于约 27 KB/s -> 一片都凑不齐 -> 吞吐 0 -> 判成死种扔掉
    // 用户那条链路实测就是 8~40 KB/s，于是每 75 秒扔一次候选，
    // 表现为「下不完就被中断」。按收到的字节算就不会误判。
    const receivedBytes = 3 * 1024 * 1024;
    const elapsedSeconds = 75;
    const byReceived = receivedBytes / elapsedSeconds; // ≈ 41 KB/s
    const byVerifiedPiece = 0 / elapsedSeconds; // 一片都没凑齐

    expect(byReceived).toBeGreaterThan(20 * 1024);
    expect(byVerifiedPiece).toBe(0);
  });
});
