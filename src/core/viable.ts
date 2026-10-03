import type { ScoredCandidate } from '../anime/rank.js';
import { announce } from '../bittorrent/tracker.js';
import { generatePeerId, hexToBytes } from '../bittorrent/peer.js';
import { magnetInfoHash } from '../util/magnet.js';
import { PUBLIC_TRACKERS } from '../bittorrent/public-trackers.js';
import { logger } from '../util/log.js';

const log = logger('probe');

/**
 * 挑「能真正下得动」的那一条候选。
 *
 * 为什么需要这一步：搜索结果的做种数字段大多数时候是空的，而公共种子里
 * 死种比例很高 —— 实测某条 4.8GB 合集只有 1 个做种且连不上。
 * 直接按打分选，很容易挑到一条根本没速度的，然后卡在那里。
 *
 * 做法：拿候选的 infohash 去一组公共 tracker 上 announce，看真实做种数。
 * UDP announce 很快，几十条并行也就一两秒。
 */

/** 用于探活的公共 tracker；只用来问「这个 infohash 有多少做种」，不参与实际下载。 */
export const PROBE_TRACKERS = PUBLIC_TRACKERS;

export type SeederProbe = {
  infoHash: string;
  /** tracker 自报的做种数（多个 tracker 取最大值）。 */
  seeders: number;
  /** tracker 返回的 peer 地址数量，做种数缺失时用它兜底。 */
  peers: number;
};

/** 单条 infohash 的探活结果；全部 tracker 都失败时 seeders/peers 为 0。 */
export async function probeSeeders(
  infoHash: string,
  options: { trackers?: string[]; timeoutMs?: number; signal?: AbortSignal; peerId?: Uint8Array } = {}
): Promise<SeederProbe> {
  const trackers = options.trackers ?? PROBE_TRACKERS;
  const timeoutMs = options.timeoutMs ?? 8_000;
  const peerId = options.peerId ?? generatePeerId();
  const infoHashBytes = hexToBytes(infoHash);

  const results = await Promise.all(
    trackers.map((tracker) =>
      announce(tracker, {
        infoHash: infoHashBytes,
        peerId,
        port: 6881,
        uploaded: 0,
        downloaded: 0,
        left: 0,
        event: 'started',
        timeoutMs,
        signal: options.signal
      }).catch(() => null)
    )
  );

  let seeders = 0;
  let peers = 0;
  for (const result of results) {
    if (!result) continue;
    peers += result.peers.length;
    if (result.seeders !== null) seeders = Math.max(seeders, result.seeders);
  }

  return { infoHash, seeders, peers };
}

export type PickViableOptions = {
  /** 探活几条候选。默认 10 条，够用且不至于打太多 tracker 请求。 */
  probeLimit?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** 需要覆盖的集号；给定时优先选覆盖最多的。留空表示只要合集。 */
  episodes?: number[];
  onProbe?: (probe: SeederProbe, candidate: ScoredCandidate) => void;
};

export type ViablePick = {
  candidate: ScoredCandidate;
  probe: SeederProbe;
  /** 排过序的完整候选（带探活结果），便于调用方展示或降级。 */
  ranked: Array<{ candidate: ScoredCandidate; probe: SeederProbe }>;
};

/**
 * 在候选中挑一条：先按覆盖度/是否合集缩小范围，再按真实做种数排序。
 * 一条都探不到活种时退回「覆盖度最高」的那条，让调用方自己去撞运气。
 */
export async function pickViableCandidate(
  candidates: readonly ScoredCandidate[],
  options: PickViableOptions = {}
): Promise<ViablePick | null> {
  const usable = candidates.filter((item) => !item.rejected && (item.result.magnet || item.result.torrentUrl));
  if (usable.length === 0) return null;

  const wanted = new Set(options.episodes ?? []);
  const preRanked = [...usable].sort((a, b) => {
    if (wanted.size > 0) {
      const coverageDiff = coverageOf(b, wanted) - coverageOf(a, wanted);
      if (coverageDiff !== 0) return coverageDiff;
    } else {
      // 没有指定集号时，合集优先（用户要的是「把这一季拉下来」）
      const batchDiff = Number(b.parsed.kind === 'batch') - Number(a.parsed.kind === 'batch');
      if (batchDiff !== 0) return batchDiff;
    }
    return b.score - a.score;
  });

  const probeLimit = options.probeLimit ?? 10;
  const targets = preRanked.slice(0, probeLimit);

  /**
   * 分档后再比做种数。
   *
   * 直接按做种数排序会出问题：一个做种很多**单集**会压过整季合集，
   * 而用户要的是「把这一季拉下来」。所以先分档 —— 覆盖度（指定了集号时）
   * 或「是不是整季」—— 只有在同一档里才比做种数。
   */
  const tierOf = (candidate: ScoredCandidate): number => {
    if (wanted.size > 0) return coverageOf(candidate, wanted);
    // 明确的合集最高；其次是没有集号信息的整季发布（不少 BDRip 合集标题里根本不写集号）；
    // 单集发布垫底 —— 用户说「下载这部番」时不会只想要其中一集
    if (candidate.parsed.kind === 'batch') return 2;
    if (candidate.parsed.kind === 'unknown') return 1;
    return 0;
  };

  const probes = await Promise.all(
    targets.map(async (candidate) => {
      const infoHash = candidate.result.magnet ? magnetInfoHash(candidate.result.magnet) : null;
      if (!infoHash) {
        // 只有 .torrent 直链时没法 announce，给它一个中性分
        return { candidate, probe: { infoHash: '', seeders: 0, peers: 0 } as SeederProbe };
      }
      const probe = await probeSeeders(infoHash, {
        timeoutMs: options.timeoutMs,
        signal: options.signal
      });
      options.onProbe?.(probe, candidate);
      return { candidate, probe };
    })
  );

  // 先按做种数排，再做种数相同按原有偏好顺序（preRanked 已经排好）
  const order = new Map(targets.map((candidate, index) => [candidate, index]));
  probes.sort((a, b) => {
    const tierDiff = tierOf(b.candidate) - tierOf(a.candidate);
    if (tierDiff !== 0) return tierDiff;
    if (b.probe.seeders !== a.probe.seeders) return b.probe.seeders - a.probe.seeders;
    if (b.probe.peers !== a.probe.peers) return b.probe.peers - a.probe.peers;
    return (order.get(a.candidate) ?? 0) - (order.get(b.candidate) ?? 0);
  });

  const best = probes[0];
  if (!best) return null;

  if (best.probe.seeders === 0 && best.probe.peers === 0) {
    log.warn(
      `前 ${targets.length} 条候选在公共 tracker 上都探不到做种，` +
        `退回偏好最高的一条：《${best.candidate.result.title.slice(0, 60)}》`
    );
  } else {
    log.info(
      `探活结果：做种最多的一条是《${best.candidate.result.title.slice(0, 60)}》` +
        `（做种 ${best.probe.seeders}，peer ${best.probe.peers}）`
    );
  }

  return { candidate: best.candidate, probe: best.probe, ranked: probes };
}

/** 这条发布覆盖了多少个目标集。 */
function coverageOf(candidate: ScoredCandidate, wanted: ReadonlySet<number>): number {
  const from = candidate.parsed.episodeFrom;
  const to = candidate.parsed.episodeTo;

  let covered = 0;
  for (const episode of wanted) {
    // 单集发布用 episodes 命中；区间过大的合集 parsed.episodes 会留空，退回用区间判断
    if (candidate.parsed.episodes.includes(episode)) covered += 1;
    else if (from !== null && to !== null && episode >= from && episode <= to) covered += 1;
  }
  return covered;
}
