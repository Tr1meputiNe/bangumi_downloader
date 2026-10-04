import { describe, expect, it } from 'vitest';
import { isEpisodeReady } from '../src/planner/client.js';

/**
 * 「播出后多久该有片源」的判定。
 *
 * 现实依据：番剧字幕组的种子一般在播出后 30~60 分钟出现在片源站。
 * 只按「播出日期 <= 今天」判断的话，播出当天一整天都会反复搜、反复落空；
 * 这个函数负责把「现在该有链接了吗」算准。
 */

const at = (iso: string) => new Date(iso);

describe('isEpisodeReady', () => {
  const episode = { airdate: '2026-10-04', airTime: '16:00' };

  it('延迟为 0 时不判断时刻（保持旧行为）', () => {
    expect(isEpisodeReady(episode, 0, at('2026-10-04T00:01:00'))).toBe(true);
    expect(isEpisodeReady(episode, null, at('2026-10-04T00:01:00'))).toBe(true);
  });

  it('播出前：还不该下', () => {
    expect(isEpisodeReady(episode, 60, at('2026-10-04T15:59:00'))).toBe(false);
  });

  it('刚播完、片源还没出：不该下', () => {
    expect(isEpisodeReady(episode, 60, at('2026-10-04T16:10:00'))).toBe(false);
    expect(isEpisodeReady(episode, 60, at('2026-10-04T16:59:00'))).toBe(false);
  });

  it('播出满 60 分钟：该下了', () => {
    expect(isEpisodeReady(episode, 60, at('2026-10-04T17:00:00'))).toBe(true);
    expect(isEpisodeReady(episode, 60, at('2026-10-04T17:30:00'))).toBe(true);
  });

  it('延迟 30 分钟时，30 分钟后就算就绪', () => {
    expect(isEpisodeReady(episode, 30, at('2026-10-04T16:29:00'))).toBe(false);
    expect(isEpisodeReady(episode, 30, at('2026-10-04T16:30:00'))).toBe(true);
  });

  it('拿不到播出时刻时不拦（宁可早试，也别因为缺字段永远不下）', () => {
    expect(isEpisodeReady({ airdate: '2026-10-04' }, 60, at('2026-10-04T00:01:00'))).toBe(true);
    expect(isEpisodeReady({ airdate: '2026-10-04', airTime: '' }, 60, at('2026-10-04T00:01:00'))).toBe(true);
    expect(isEpisodeReady({ airdate: '2026-10-04', airTime: '不是时间' }, 60, at('2026-10-04T00:01:00'))).toBe(true);
  });

  it('跨天的播出时刻按当地日期算，不会因为只差几分钟就误判', () => {
    // 23:30 播出 + 60 分钟缓冲 => 次日 00:30 才就绪
    const late = { airdate: '2026-10-04', airTime: '23:30' };
    expect(isEpisodeReady(late, 60, at('2026-10-04T23:59:00'))).toBe(false);
    expect(isEpisodeReady(late, 60, at('2026-10-05T00:29:00'))).toBe(false);
    expect(isEpisodeReady(late, 60, at('2026-10-05T00:30:00'))).toBe(true);
  });

  it('非法时刻（25:00）不拦', () => {
    expect(isEpisodeReady({ airdate: '2026-10-04', airTime: '25:00' }, 60, at('2026-10-04T00:01:00'))).toBe(true);
  });
});
