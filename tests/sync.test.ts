import { describe, expect, it } from 'vitest';
import { groupByTorrent, selectFileIndexes } from '../src/core/sync.js';
import type { ScoredCandidate } from '../src/anime/rank.js';
import { parseReleaseName } from '../src/anime/parse.js';

function candidate(title: string, magnet: string): ScoredCandidate {
  const parsed = parseReleaseName(title);
  return {
    result: {
      title,
      magnet,
      sizeBytes: 1024 ** 3,
      publishedAt: null,
      seederCount: 10,
      leecherCount: null,
      tracker: 'test',
      provider: 'test'
    },
    parsed,
    score: 1,
    reasons: [],
    coversEpisodes: parsed.episodes,
    rejected: false
  };
}

describe('selectFileIndexes', () => {
  it('从合集文件清单里只挑出目标集', () => {
    const files = [
      { index: 0, path: 'Frieren/01.mkv' },
      { index: 1, path: 'Frieren/02.mkv' },
      { index: 2, path: 'Frieren/03.mkv' },
      { index: 3, path: 'Frieren/04.mkv' }
    ];
    const selected = selectFileIndexes(files, [2]);
    expect(selected.indexes).toEqual([1]);
    expect(selected.matchedEpisodes).toEqual([2]);
  });

  it('同时命中多集时全部选中', () => {
    const files = [
      { index: 0, path: 'Frieren/[Group] Frieren - 05 [1080p].mkv' },
      { index: 1, path: 'Frieren/[Group] Frieren - 06 [1080p].mkv' },
      { index: 2, path: 'Frieren/[Group] Frieren - 07 [1080p].mkv' }
    ];
    const selected = selectFileIndexes(files, [5, 6]);
    expect(selected.indexes).toEqual([0, 1]);
    expect(selected.matchedEpisodes).toEqual([5, 6]);
  });

  it('跳过特典 / NC / 字体等非正片文件', () => {
    const files = [
      { index: 0, path: 'Frieren/01.mkv' },
      { index: 1, path: 'Frieren/NCOP.mkv' },
      { index: 2, path: 'Frieren/fonts.zip' },
      { index: 3, path: 'Frieren/SP01.mkv' }
    ];
    const selected = selectFileIndexes(files, [1]);
    expect(selected.indexes).toEqual([0]);
  });

  it('没有命中任何目标集时返回空', () => {
    const files = [{ index: 0, path: 'Frieren/09.mkv' }];
    const selected = selectFileIndexes(files, [1]);
    expect(selected.indexes).toEqual([]);
    expect(selected.matchedEpisodes).toEqual([]);
  });

  it('兼容只有 name 字段的文件列表', () => {
    const files = [{ index: 0, name: 'Frieren - 03.mkv' }];
    expect(selectFileIndexes(files, [3]).indexes).toEqual([0]);
  });
});

describe('groupByTorrent', () => {
  const magnetA = `magnet:?xt=urn:btih:${'a'.repeat(40)}`;
  const magnetB = `magnet:?xt=urn:btih:${'b'.repeat(40)}`;

  it('同一合集覆盖多集时合并成一次推送', () => {
    const plans = groupByTorrent(
      [
        { episode: 5, candidate: candidate('[G] Frieren 01-12 合集 [1080p]', magnetA) },
        { episode: 6, candidate: candidate('[G] Frieren 01-12 合集 [1080p]', magnetA) }
      ],
      { id: 1, name: '葬送的芙莉莲' }
    );
    expect(plans.length).toBe(1);
    expect(plans[0]!.episodes).toEqual([5, 6]);
  });

  it('不同 infohash 拆成多个推送', () => {
    const plans = groupByTorrent(
      [
        { episode: 5, candidate: candidate('[G] Frieren - 05 [1080p]', magnetA) },
        { episode: 6, candidate: candidate('[G] Frieren - 06 [1080p]', magnetB) }
      ],
      { id: 1, name: '葬送的芙莉莲' }
    );
    expect(plans.length).toBe(2);
    expect(plans.map((plan) => plan.episodes)).toEqual([[5], [6]]);
  });

  it('集号排序稳定', () => {
    const plans = groupByTorrent(
      [
        { episode: 8, candidate: candidate('[G] Frieren 01-12 合集', magnetA) },
        { episode: 3, candidate: candidate('[G] Frieren 01-12 合集', magnetA) }
      ],
      { id: 1, name: '葬送的芙莉莲' }
    );
    expect(plans[0]!.episodes).toEqual([3, 8]);
  });

  it('没有磁力时退回用标题做分组键', () => {
    const noMagnet: ScoredCandidate = {
      ...candidate('[G] Frieren 01-12 合集', ''),
      result: { ...candidate('[G] Frieren 01-12 合集', '').result, torrentUrl: 'https://t/1.torrent' }
    };
    const plans = groupByTorrent(
      [
        { episode: 5, candidate: noMagnet },
        { episode: 6, candidate: noMagnet }
      ],
      { id: 1, name: '葬送的芙莉莲' }
    );
    expect(plans.length).toBe(1);
    expect(plans[0]!.episodes).toEqual([5, 6]);
  });
});
