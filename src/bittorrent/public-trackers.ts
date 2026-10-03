/**
 * 一组公共 tracker。
 *
 * 两个用途：
 *  1. 探活：下载前问一下「这个 infohash 现在有多少做种」，避免挑到死种；
 *  2. 补源：animes.garden 给出的磁力经常只带一两个 tracker，
 *     只靠它们找 peer 很容易一个都拿不到，需要这组列表兜底。
 *
 * 放在这里而不是 viable.ts，是为了别让下载引擎反向依赖上层的选种逻辑。
 */
export const PUBLIC_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://explodie.org:6969/announce',
  'udp://tracker1.bt.moack.co.kr:80/announce',
  'http://nyaa.tracker.wf:7777/announce'
];
