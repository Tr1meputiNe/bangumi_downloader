import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { html } from './html.js';
import { StatusDot, Toasts } from './components.js';
import { activeBadge, refreshNow, startStore, useStore } from './store.js';
import { shortenPath } from './format.js';
import { OverviewView } from './views/overview.js';
import { SearchView } from './views/search.js';
import { JobsView } from './views/jobs.js';
import { PlanView } from './views/plan.js';
import { LibraryView } from './views/library.js';
import { SettingsView } from './views/settings.js';
import { LogsView } from './views/logs.js';

/**
 * 界面外壳：左侧导航 + 右侧视图。
 *
 * 用 hash 路由而不是 History API：这个页面是从服务端内联出来的单文件，
 * 没有静态资源目录、也没有服务端路由，hash 是唯一不需要服务端配合的方案，
 * 而且刷新、前进后退、收藏某个页面都能正常工作。
 */

type RouteId = 'overview' | 'search' | 'jobs' | 'plan' | 'library' | 'settings' | 'logs';

const ROUTES: Array<{ id: RouteId; label: string; icon: string; hint: string }> = [
  { id: 'overview', label: '概览', icon: '◎', hint: '现在什么情况' },
  { id: 'search', label: '下载', icon: '⌕', hint: '搜片源、挑种子' },
  { id: 'jobs', label: '任务', icon: '⇩', hint: '下载进度与后台任务' },
  { id: 'plan', label: '计划', icon: '◷', hint: '追番清单与计划任务' },
  { id: 'library', label: '片库', icon: '▤', hint: '已下载的内容' },
  { id: 'settings', label: '设置', icon: '⚙', hint: 'config.json' },
  { id: 'logs', label: '日志', icon: '≡', hint: '运行记录' }
];

function parseRoute(hash: string): RouteId {
  const id = hash.replace(/^#\/?/, '').split('?')[0] as RouteId;
  return ROUTES.some((route) => route.id === id) ? id : 'overview';
}

function App() {
  const store = useStore();
  const [route, setRoute] = useState<RouteId>(() => parseRoute(location.hash));

  useEffect(() => {
    const onHashChange = () => setRoute(parseRoute(location.hash));
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    const current = ROUTES.find((item) => item.id === route);
    document.title = current ? `${current.label} · 番剧下载器` : '番剧下载器';
  }, [route]);

  const badge = activeBadge(store);

  return html`
    <div class="app">
      <aside class="sidebar">
        <div class="brand">
          <span class="logo">番</span>
          <div class="brand-text">
            <strong>番剧下载器</strong>
            <span class="dim small">v${store.status?.version ?? '…'}</span>
          </div>
        </div>

        <nav class="nav">
          ${ROUTES.map(
            (item) => html`
              <a
                class=${`nav-item ${route === item.id ? 'active' : ''}`}
                href=${`#/${item.id}`}
                title=${item.hint}
              >
                <span class="nav-icon">${item.icon}</span>
                <span class="nav-label">${item.label}</span>
                ${item.id === 'jobs' && badge > 0 ? html`<span class="nav-badge">${badge}</span>` : null}
              </a>
            `
          )}
        </nav>

        <div class="sidebar-foot">
          <div class="stat-line">
            <${StatusDot} ok=${store.online && (store.status?.qbittorrent ?? '') === 'ok'} />
            <span class="small">${store.status?.backendLabel ?? '连接中…'}</span>
          </div>
          ${store.status?.savePath
            ? html`<div class="dim small mono" title=${store.status.savePath}>${shortenPath(store.status.savePath, 2)}</div>`
            : null}
          <button type="button" class="ghost small full" onClick=${() => void refreshNow()}>刷新状态</button>
        </div>
      </aside>

      <main class="main">
        ${!store.online &&
        html`<div class="banner err">
          和后端失去联系了${store.lastError ? `：${store.lastError}` : ''} —— 检查那台机器上的服务是否还在跑。
        </div>`}

        ${route === 'overview' && html`<${OverviewView} />`}
        ${route === 'search' && html`<${SearchView} />`}
        ${route === 'jobs' && html`<${JobsView} />`}
        ${route === 'plan' && html`<${PlanView} />`}
        ${route === 'library' && html`<${LibraryView} />`}
        ${route === 'settings' && html`<${SettingsView} />`}
        ${route === 'logs' && html`<${LogsView} />`}
      </main>

      <${Toasts} />
    </div>
  `;
}

startStore();

const root = document.getElementById('app');
if (root) render(html`<${App} />`, root);
