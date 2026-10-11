import { useEffect, useState } from 'preact/hooks';
import { api, type AutoStatus, type JobCounts, type JobView, type StatusResponse, type TaskView } from './api.js';

/**
 * 全局状态：状态栏、下载任务、后台任务。
 *
 * 为什么做成一个共享的 store 而不是每个视图各自轮询：
 * 这些数据在多个页面上都要显示（任务数在侧边栏上就有角标），
 * 每个视图都开一个定时器的话，切页面会互相打断、请求也会翻倍。
 * 这里统一轮询一次，谁需要谁订阅。
 *
 * 轮询节奏跟着「有没有活儿」走：有下载/任务在跑时 2.5 秒一次（进度条要动），
 * 空闲时 8 秒一次；页面被切到后台时统一放慢到 20 秒，不浪费那台机器的资源。
 */

export type ToastKind = 'ok' | 'err' | 'info';
export type Toast = { id: number; kind: ToastKind; text: string };

export type AppState = {
  /** 自动追番（另一个进程）的状态。 */
  auto: AutoStatus | null;
  status: StatusResponse | null;
  jobs: JobView[];
  counts: JobCounts;
  jobsRunning: boolean;
  tasks: TaskView[];
  tasksRunning: boolean;
  toasts: Toast[];
  /** 后端是否可达（连续请求失败时为 false，界面顶部会提示）。 */
  online: boolean;
  lastError: string | null;
  /** 最近一次成功刷新的时间戳，用来判断数据有多旧。 */
  updatedAt: number;
};

const EMPTY_COUNTS: JobCounts = { running: 0, queued: 0, paused: 0, completed: 0, failed: 0, cancelled: 0 };

let state: AppState = {
  status: null,
  jobs: [],
  counts: EMPTY_COUNTS,
  jobsRunning: false,
  auto: null,
  tasks: [],
  tasksRunning: false,
  toasts: [],
  online: true,
  lastError: null,
  updatedAt: 0
};

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;
let started = false;
let toastSeq = 0;

function set(patch: Partial<AppState>): void {
  state = { ...state, ...patch };
  for (const listener of [...listeners]) listener();
}

/** 弹一条提示，几秒后自动消失。 */
export function notify(kind: ToastKind, text: string): void {
  const toast: Toast = { id: ++toastSeq, kind, text };
  set({ toasts: [...state.toasts, toast] });
  setTimeout(() => dismissToast(toast.id), kind === 'err' ? 8000 : 4500);
}

export function dismissToast(id: number): void {
  set({ toasts: state.toasts.filter((toast) => toast.id !== id) });
}

function nextDelay(): number {
  const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
  if (hidden) return 20_000;
  return state.jobsRunning || state.tasksRunning ? 2500 : 8000;
}

async function tick(): Promise<void> {
  try {
    const [jobs, tasks] = await Promise.all([api.jobs(), api.tasks()]);
    set({
      jobs: jobs.jobs,
      counts: jobs.counts,
      jobsRunning: jobs.running,
      auto: jobs.auto ?? null,
      tasks: tasks.tasks,
      tasksRunning: tasks.running,
      online: true,
      lastError: null,
      updatedAt: Date.now()
    });
  } catch (error) {
    set({ online: false, lastError: error instanceof Error ? error.message : String(error) });
  }
  schedule();
}

function schedule(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void tick(), nextDelay());
}

/** 只刷新一次（点了按钮之后用，别等下一个轮询周期）。 */
export async function refreshNow(): Promise<void> {
  if (timer) clearTimeout(timer);
  await tick();
}

/** 拉一次状态（后端/版本/路径），页面启动和手动刷新时用。 */
export async function refreshStatus(): Promise<void> {
  try {
    const status = await api.status();
    set({ status, online: true });
  } catch (error) {
    set({ online: false, lastError: error instanceof Error ? error.message : String(error) });
  }
}

export function startStore(): void {
  if (started) return;
  started = true;
  void refreshStatus();
  void tick();
  // 从后台切回来时立刻刷一次，别让用户盯着过期的进度
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void refreshNow();
  });
}

export function useStore(): AppState {
  const [, force] = useState(0);
  useEffect(() => {
    const listener = () => force((value) => value + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return state;
}

/** 侧边栏角标：正在跑的下载数 + 后台任务数。 */
export function activeBadge(state: AppState): number {
  return state.counts.running + state.counts.queued + state.tasks.filter((task) => task.status === 'running').length;
}
