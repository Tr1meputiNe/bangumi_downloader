/**
 * 前端资源以「默认导出一段字符串的模块」形式提供。
 *
 * 为什么要内联而不是运行时读文件：最终产物是单文件 exe，
 * 运行目录里没有也不该有 assets 目录。只有把前端内容在打包时就嵌进 bundle，
 * exe 才能真正做到「一个文件走天下」。
 *
 * 仓库里提交的是占位实现（未构建状态），真实内容由 scripts/build-client.mjs
 * 生成并覆盖 generated/ 下的两个模块。请不要手工编辑它们。
 */
import clientJsText from './generated/client-bundle.js';
import clientCssText from './generated/client-style.js';

/** 未构建时的占位内容。 */
const PLACEHOLDER_MARKER = '__CLIENT_NOT_BUILT__';

function isValid(text: string): boolean {
  return typeof text === 'string' && text.trim() !== '' && !text.includes(PLACEHOLDER_MARKER);
}

/** 前端 JS；未构建时返回 null。 */
export function clientJs(): string | null {
  return isValid(clientJsText) ? clientJsText : null;
}

/** 前端 CSS；未构建时返回 null。 */
export function clientCss(): string | null {
  return isValid(clientCssText) ? clientCssText : null;
}

export { PLACEHOLDER_MARKER };
