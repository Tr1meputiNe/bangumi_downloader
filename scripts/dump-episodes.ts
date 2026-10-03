/** 打印某关键词下候选解析出的集号，用来查「离谱集号」的来源。 */
import { loadConfig } from '../src/config.js';
import { searchAndRank } from '../src/core/search.js';

const query = process.argv[2] ?? '吹响上低音号 第三季';
const config = loadConfig({ configPath: './config.json' }).config;
const result = await searchAndRank({ query, config, mode: 'manual' });

for (const item of result.ranked) {
  if (item.rejected) continue;
  const eps = item.parsed.episodes;
  const max = eps.length > 0 ? Math.max(...eps) : 0;
  if (max < 100) continue;
  console.log(
    `episodes=[${eps.slice(0, 8).join(',')}${eps.length > 8 ? ',…' : ''}] kind=${item.parsed.kind} ` +
      `range=${item.parsed.episodeFrom}-${item.parsed.episodeTo}\n   ${item.result.title.slice(0, 90)}`
  );
}
