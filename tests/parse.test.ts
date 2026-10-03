import { describe, expect, it } from 'vitest';
import { matchesEpisode, parseReleaseName, parseSeason, seasonCompatible, normalizeDigits } from '../src/anime/parse.js';

describe('normalizeDigits', () => {
  it('把全角数字转成半角', () => {
    expect(normalizeDigits('第０１话')).toBe('第01话');
  });

  it('把中文数字转成阿拉伯数字', () => {
    expect(normalizeDigits('第二季')).toBe('第2季');
    expect(normalizeDigits('第十二话')).toBe('第12话');
    expect(normalizeDigits('第十话')).toBe('第10话');
  });
});

describe('parseSeason', () => {
  it('识别 S02 与第二季', () => {
    expect(parseSeason('Sousou no Frieren S02')).toBe(2);
    expect(parseSeason('葬送的芙莉莲 第二季')).toBe(2);
    expect(parseSeason('正反対な君と僕 第2期')).toBe(2);
    expect(parseSeason('2nd Season')).toBe(2);
  });

  it('没有季度信息时返回 null', () => {
    expect(parseSeason('葬送的芙莉莲')).toBeNull();
  });
});

describe('parseReleaseName', () => {
  it('解析中文双语标题里的集号', () => {
    const parsed = parseReleaseName('[喵萌奶茶屋&LoliHouse] 葬送的芙莉莲 / Sousou no Frieren - 37 [WebRip 1080p HEVC-10bit AAC][简繁日内封字幕]');
    expect(parsed.episodes).toContain(37);
    expect(parsed.resolution).toBe('1080p');
    expect(parsed.subtitle).toBe('简繁');
    expect(parsed.videoCodec).toBe('hevc');
    expect(parsed.bitDepth).toBe(10);
    expect(parsed.group).toBe('喵萌奶茶屋&LoliHouse');
  });

  it('解析中文「第01话」格式并识别 mkv', () => {
    const parsed = parseReleaseName('【悠哈璃羽字幕社】[葬送的芙莉莲 第二季][37][1080p HEVC][CHS][简体内嵌].mkv');
    expect(parsed.episodes).toContain(37);
    expect(parsed.container).toBe('mkv');
    expect(parsed.subtitle).toBe('简体');
    expect(parsed.kind).toBe('single');
    expect(parsed.season).toBe(2);
  });

  it('识别单集 mkv 1080p 简中', () => {
    const parsed = parseReleaseName('[ANi] Sousou no Frieren S02 - 05 [1080P][Baha][WEB-DL][AAC AVC][CHT][MP4]');
    expect(parsed.episodes).toContain(5);
    expect(parsed.resolution).toBe('1080p');
    expect(parsed.container).toBe('mp4');
    expect(parsed.subtitle).toBe('繁体');
    expect(parsed.season).toBe(2);
  });

  it('识别合集区间', () => {
    const parsed = parseReleaseName('[7³ACG] 葬送的芙莉莲/Sousou no Frieren S01 | 29-38+SPx11 [简繁字幕] BDrip 1080p x265 OPUS 2.0');
    expect(parsed.kind).toBe('batch');
    expect(parsed.episodeFrom).toBe(29);
    expect(parsed.episodeTo).toBe(38);
    expect(matchesEpisode(parsed, 31)).toBe(true);
    expect(matchesEpisode(parsed, 39)).toBe(false);
  });

  it('识别中文区间「第29-38话」', () => {
    const parsed = parseReleaseName('[千夏字幕组][葬送的芙莉莲][第29-38话][1080p_AVC][简体][合集]');
    expect(parsed.kind).toBe('batch');
    expect(parsed.episodeFrom).toBe(29);
    expect(parsed.episodeTo).toBe(38);
    expect(matchesEpisode(parsed, 35)).toBe(true);
  });

  it('区间过大时只保留区间下界，避免生成上万集', () => {
    const parsed = parseReleaseName('葬送的芙莉莲 01-1000 合集');
    expect(parsed.kind).toBe('batch');
    expect(parsed.episodes.length).toBeLessThanOrEqual(61);
  });

  it('不会把 1080p / x265 当成集号', () => {
    const parsed = parseReleaseName('[ReinForce] Frieren (BDRip 1920x1080 x264 FLAC)');
    expect(parsed.episodes).not.toContain(1080);
    expect(parsed.episodes).not.toContain(265);
  });

  it('识别 2160p 与 10bit', () => {
    const parsed = parseReleaseName('[Shiniori-Raws]葬送的芙莉莲 第二季/Sousou no Frieren S2 4k 2160p x265 10bit');
    expect(parsed.resolution).toBe('2160p');
    expect(parsed.bitDepth).toBe(10);
    expect(parsed.season).toBe(2);
  });

  it('标记特别篇/NC 而不去匹配正片', () => {
    const parsed = parseReleaseName('[Group] Frieren NCOP [1080p]');
    expect(parsed.isSpecial).toBe(true);
    expect(parsed.episodes).toEqual([]);
  });
});

describe('seasonCompatible', () => {
  it('发布未写季度时一律放行', () => {
    const parsed = parseReleaseName('[Group] Frieren - 05 [1080p].mkv');
    expect(seasonCompatible(parsed, 2)).toBe(true);
  });

  it('明确写了别的季度时判定不匹配', () => {
    const parsed = parseReleaseName('[Group] Frieren S01 - 05 [1080p].mkv');
    expect(seasonCompatible(parsed, 2)).toBe(false);
  });

  it('季度一致时匹配', () => {
    const parsed = parseReleaseName('[Group] Frieren S02 - 05 [1080p].mkv');
    expect(seasonCompatible(parsed, 2)).toBe(true);
  });

  it('目标季度未知时不做限制', () => {
    const parsed = parseReleaseName('[Group] Frieren S01 - 05 [1080p].mkv');
    expect(seasonCompatible(parsed, null)).toBe(true);
  });
});
