import type { ComponentChildren } from 'preact';
import { html } from './html.js';
import { dismissToast, useStore } from './store.js';

/** 界面上的通用小部件。集中放在这里，避免每个视图各写一套长得不一样的卡片和按钮。 */

export function Card({
  title,
  hint,
  actions,
  children,
  className = ''
}: {
  title?: ComponentChildren;
  hint?: ComponentChildren;
  actions?: ComponentChildren;
  children?: ComponentChildren;
  className?: string;
}) {
  return html`
    <section class=${`card ${className}`}>
      ${(title || actions) &&
      html`
        <header class="card-head">
          <div>
            ${title && html`<h2>${title}</h2>`}
            ${hint && html`<p class="card-hint">${hint}</p>`}
          </div>
          ${actions && html`<div class="card-actions">${actions}</div>`}
        </header>
      `}
      <div class="card-body">${children}</div>
    </section>
  `;
}

export function ProgressBar({ percent, indeterminate = false }: { percent: number | null; indeterminate?: boolean }) {
  if (indeterminate) return html`<div class="bar"><div class="bar-fill indeterminate"></div></div>`;
  const width = Math.max(0, Math.min(100, percent ?? 0));
  return html`<div class="bar"><div class="bar-fill" style=${`width:${width}%`}></div></div>`;
}

export function Empty({ text, hint }: { text: string; hint?: ComponentChildren }) {
  return html`
    <div class="empty">
      <div>${text}</div>
      ${hint && html`<div class="dim small">${hint}</div>`}
    </div>
  `;
}

export function Badge({ kind = '', title, children }: { kind?: string; title?: string; children: ComponentChildren }) {
  return html`<span class=${`badge ${kind}`} title=${title}>${children}</span>`;
}

export function IconButton({
  icon,
  label,
  onClick,
  danger = false,
  disabled = false
}: {
  icon: string;
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return html`
    <button
      type="button"
      class=${`icon ${danger ? 'danger' : ''}`}
      title=${label}
      aria-label=${label}
      disabled=${disabled}
      onClick=${onClick}
    >
      ${icon}
    </button>
  `;
}

export function Spinner({ label }: { label?: string }) {
  return html`<span class="spinner-wrap"><span class="spinner"></span>${label && html`<span class="dim small">${label}</span>`}</span>`;
}

export function StatusDot({ ok, title }: { ok: boolean; title?: string }) {
  return html`<span class=${`dot ${ok ? 'on' : 'off'}`} title=${title}></span>`;
}

/** 顶部弹出的提示条。全局只有一个实例，挂在 app 里。 */
export function Toasts() {
  const state = useStore();
  if (state.toasts.length === 0) return null;
  return html`
    <div class="toasts">
      ${state.toasts.map(
        (toast) => html`
          <div class=${`toast ${toast.kind}`} onClick=${() => dismissToast(toast.id)}>
            <span>${toast.kind === 'ok' ? '✓' : toast.kind === 'err' ? '✗' : 'ℹ'}</span>
            <span>${toast.text}</span>
          </div>
        `
      )}
    </div>
  `;
}

/** 可折叠区域：日志、文件列表这类「平时不想看、需要时要能看到」的内容。 */
export function Collapsible({
  label,
  open,
  onToggle,
  children,
  meta
}: {
  label: ComponentChildren;
  open: boolean;
  onToggle: () => void;
  children: ComponentChildren;
  meta?: ComponentChildren;
}) {
  return html`
    <div class="collapse">
      <div class="collapse-head">
        <button type="button" class="linklike" onClick=${onToggle}>${open ? '▾' : '▸'} ${label}</button>
        ${meta && html`<span class="dim small">${meta}</span>`}
      </div>
      ${open && html`<div class="collapse-body">${children}</div>`}
    </div>
  `;
}

/** 表单里的一行：标签 + 输入 + 说明。 */
export function Field({
  label,
  hint,
  children,
  wide = false
}: {
  label: ComponentChildren;
  hint?: ComponentChildren;
  children: ComponentChildren;
  wide?: boolean;
}) {
  return html`
    <label class=${`field ${wide ? 'wide' : ''}`}>
      <span class="field-label">${label}</span>
      <span class="field-control">${children}</span>
      ${hint && html`<span class="field-hint">${hint}</span>`}
    </label>
  `;
}
