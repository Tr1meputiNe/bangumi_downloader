/**
 * htm 的 preact 版本已经绑好了 h，且自带类型声明，直接用即可。
 * 注意要用裸包名 'htm/preact' —— 带上 /index.js 会绕过 package.json
 * 的 exports 类型解析，tsc 会把整个模块当成命名空间而报「不可调用」。
 */
export { html } from 'htm/preact';
