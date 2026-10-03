import { describe, expect, it } from 'vitest';
import { pickRelease, rankCandidates, type SearchResult, type TargetEpisode } from '../src/anime/rank.js';
import { defaultConfig } from '../src/config.js';

function target(episode: number, season: number | null = 2): TargetEpisode {
  return {
    subjectId: 1,
    subjectName: 'Sousou no Frieren S2',
    subjectNameCn: '葬送的芙莉莲 第二季',
    episode,
    season,
    airDate: '2026-01-10'
  };
}

function result(overrides: Partial<SearchResult> & { title: string }): SearchResult {
  return {
    magnet: `magnet:?xt=urn:btih:${Math.random().toString(16).slice(2).padEnd(40, '0')}`,
    sizeBytes: 1024 ** 3,
    publishedAt: null,
    seederCount: 10,
    leecherCount: null,
    tracker: 'test',
    provider: 'test',
    ...overrides
  };
}

const config = defaultConfig();

describe('rankCandidates 偏好排序', () => {
  it('MKV + 1080p + 简中 排在最前', () => {
    const results = [
      result({ title: '[A] Frieren S02 - 05 [1080p][AVC][繁体][MP4]' }),
      result({ title: '[B] 葬送的芙莉莲 第二季 - 05 [1080p][HEVC][简体内嵌].mkv' }),
      result({ title: '[C] Frieren S02 - 05 [720p][AVC][简体][MP4]' })
    ];
    const ranked = rankCandidates(results, { preference: config.preference, targets: [target(5)], targetSeason: 2 });
    expect(ranked[0]?.result.title).toContain('简体内嵌');
    expect(ranked[0]?.parsed.container).toBe('mkv');
  });

  it('淘汰命中排除词的发布（预告/PV）', () => {
    const results = [
      result({ title: '[A] Frieren S02 - 05 预告 [1080p]' }),
      result({ title: '[B] Frieren S02 - 05 [1080p][简体].mkv' })
    ];
    const ranked = rankCandidates(results, { preference: config.preference, targets: [target(5)], targetSeason: 2 });
    const pv = ranked.find((item) => item.result.title.includes('预告'));
    expect(pv?.rejected).toBe(true);
    expect(pv?.rejectReason).toContain('排除词');
    expect(ranked[0]?.result.title).toContain('简体');
  });

  it('淘汰不覆盖目标集号的发布', () => {
    const results = [result({ title: '[A] Frieren S02 - 06 [1080p][简体].mkv' })];
    const ranked = rankCandidates(results, { preference: config.preference, targets: [target(5)], targetSeason: 2 });
    expect(ranked[0]?.rejected).toBe(true);
    expect(ranked[0]?.rejectReason).toContain('集号');
  });

  it('淘汰明确写了别的季度的发布', () => {
    const results = [
      result({ title: '[A] Frieren S01 - 05 [1080p][简体].mkv' }),
      result({ title: '[B] Frieren S02 - 05 [1080p][繁体].mp4' })
    ];
    const ranked = rankCandidates(results, { preference: config.preference, targets: [target(5)], targetSeason: 2 });
    const first = ranked.find((item) => item.result.title.includes('S01'));
    expect(first?.rejected).toBe(true);
    expect(ranked[0]?.result.title).toContain('S02');
  });

  it('合集覆盖多集时拿到合集加分', () => {
    const results = [
      result({ title: '[A] Frieren S02 - 05 [1080p][简体].mkv' }),
      result({ title: '[B] 葬送的芙莉莲 第二季 01-12 合集 [1080p][简繁][BDRip].mkv', sizeBytes: 20 * 1024 ** 3 })
    ];
    const ranked = rankCandidates(results, {
      preference: config.preference,
      targets: [target(5), target(6)],
      targetSeason: 2
    });
    const batch = ranked.find((item) => item.result.title.includes('合集'));
    expect(batch?.coversEpisodes.sort()).toEqual([5, 6]);
    expect(batch?.reasons.some((reason) => reason.includes('合集'))).toBe(true);
  });

  it('requireKeywords 生效', () => {
    const preference = { ...config.preference, requireKeywords: ['1080p'] };
    const results = [
      result({ title: '[A] Frieren S02 - 05 [720p][简体].mkv' }),
      result({ title: '[B] Frieren S02 - 05 [1080p][繁体].mp4' })
    ];
    const ranked = rankCandidates(results, { preference, targets: [target(5)], targetSeason: 2 });
    expect(ranked[0]?.result.title).toContain('1080p');
    expect(ranked.find((item) => item.result.title.includes('720p'))?.rejected).toBe(true);
  });

  it('字幕组白名单加分、黑名单减分', () => {
    const preference = {
      ...config.preference,
      preferGroups: ['喵萌奶茶屋'],
      avoidGroups: ['广告组']
    };
    const results = [
      result({ title: '[喵萌奶茶屋] Frieren S02 - 05 [1080p][简体].mkv' }),
      result({ title: '[广告组] Frieren S02 - 05 [1080p][简体].mkv' })
    ];
    const ranked = rankCandidates(results, { preference, targets: [target(5)], targetSeason: 2 });
    expect(ranked[0]?.result.title).toContain('喵萌奶茶屋');
    expect(ranked[0]?.score).toBeGreaterThan(ranked[1]?.score ?? 0);
  });

  it('做种多的同分发布优先', () => {
    const results = [
      result({ title: '[A] Frieren S02 - 05 [1080p][简体].mkv', seederCount: 0 }),
      result({ title: '[B] Frieren S02 - 05 [1080p][简体].mkv', seederCount: 500 })
    ];
    const ranked = rankCandidates(results, { preference: config.preference, targets: [target(5)], targetSeason: 2 });
    expect(ranked[0]?.result.seederCount).toBe(500);
  });
});

describe('pickRelease', () => {
  it('全部被淘汰时返回 null', () => {
    const results = [result({ title: '[A] 别的番 01 [1080p].mkv' })];
    const outcome = pickRelease(results, { preference: config.preference, targets: [target(5)], targetSeason: 2 });
    expect(outcome.candidate).toBeNull();
    expect(outcome.ranked.length).toBe(1);
  });

  it('返回最高分且未被淘汰的候选', () => {
    const results = [
      result({ title: '[A] Frieren S02 - 05 [720p][简体].mp4' }),
      result({ title: '[B] Frieren S02 - 05 [1080p][简体].mkv' })
    ];
    const outcome = pickRelease(results, { preference: config.preference, targets: [target(5)], targetSeason: 2 });
    expect(outcome.candidate?.parsed.container).toBe('mkv');
  });
});
