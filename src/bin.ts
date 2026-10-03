#!/usr/bin/env node
/**
 * 可执行入口。
 * 单独一个文件是为了让 src/index.ts 保持可被测试导入（导入时不自动跑 main）。
 */
import { main } from './index.js';
import { QbittorrentError } from './qbittorrent/client.js';
import { PlannerError } from './planner/client.js';
import { log } from './util/log.js';

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    if (error instanceof QbittorrentError || error instanceof PlannerError) {
      log.error(error.message);
    } else {
      log.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    }
    process.exitCode = 1;
  });
