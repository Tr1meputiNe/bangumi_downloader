import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { logger } from '../util/log.js';

const log = logger('lock');

/**
 * 单实例锁。
 *
 * 为什么需要：这套东西最终会挂到 Windows 计划任务上定时触发（例如每 30 分钟一次）。
 * 下载本身可能跑好几个小时，如果不加锁，下一次触发会再起一个进程，
 * 两个进程抢同一个种子的同一批分片 —— 互相拖慢，还可能写出重复数据。
 *
 * 用「记录 pid + 每次启动检查 pid 是否还活着」的方式，而不是简单的存在性判断：
 * 进程被强杀（关机、任务计划取消）时锁文件会残留，纯存在性判断会导致再也起不来。
 */

export type LockInfo = {
  pid: number;
  startedAt: string;
  command: string;
};

export type LockHandle = {
  path: string;
  release: () => void;
};

/** 判断 pid 是否还是一个活着的进程。 */
function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    // 信号 0 只做存在性检查，不真的发信号
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // EPERM 说明进程存在但不属于当前用户，同样算活着
    return code === 'EPERM';
  }
}

/**
 * 尝试获取锁。
 * 已被另一个活着的进程持有时返回 null；否则返回句柄（用完记得 release）。
 */
export function acquireLock(path: string, command: string): LockHandle | null {
  if (existsSync(path)) {
    try {
      const info = JSON.parse(readFileSync(path, 'utf8')) as LockInfo;
      if (info.pid !== process.pid && isProcessAlive(info.pid)) {
        log.warn(
          `已有另一个实例在跑（pid ${info.pid}，启动于 ${info.startedAt}），本次直接退出。` +
            '如果确认那个进程已经不在了，删掉这个文件即可：' + path
        );
        return null;
      }
      log.debug(`清理残留的锁文件（pid ${info.pid} 已不存在）`);
    } catch {
      log.debug('锁文件内容不合法，按残留处理');
    }
  }

  try {
    mkdirSync(dirname(path), { recursive: true });
    const info: LockInfo = { pid: process.pid, startedAt: new Date().toISOString(), command };
    writeFileSync(path, `${JSON.stringify(info, null, 2)}\n`, 'utf8');
  } catch (error) {
    log.warn(`写锁文件失败，继续执行（不阻塞下载）：${(error as Error).message}`);
    return { path, release: () => undefined };
  }

  let released = false;
  return {
    path,
    release: () => {
      if (released) return;
      released = true;
      try {
        // 只删自己写的那个锁，避免误删别人刚抢到的
        const info = JSON.parse(readFileSync(path, 'utf8')) as LockInfo;
        if (info.pid === process.pid) rmSync(path, { force: true });
      } catch {
        /* 已经被删掉就算了 */
      }
    }
  };
}
