/* 校验 app.js 里引用的 DOM id 是否都存在于 index.html */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');

const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const refIds = new Set([...app.matchAll(/\$\('([A-Za-z0-9_]+)'\)/g)].map((m) => m[1]));
// cacheDom 列表里的裸字符串
const cacheBlock = app.match(/cacheDom\(\)[\s\S]*?\]\.forEach/);
if (cacheBlock) {
  [...cacheBlock[0].matchAll(/'([A-Za-z][A-Za-z0-9_]*)'/g)].forEach((m) => refIds.add(m[1]));
}

let fail = 0;
const missing = [...refIds].filter((id) => !htmlIds.has(id));
console.log('index.html 中的 id 共 ' + htmlIds.size + ' 个，app.js 引用 ' + refIds.size + ' 个');
if (missing.length) {
  fail++;
  console.log('  \u2717 app.js 引用了不存在的 id：' + missing.join(', '));
} else {
  console.log('  \u2713 所有引用的 id 都能在 index.html 中找到');
}

// 检查 data-* 钩子：JS 里作为选择器用的属性，HTML 中必须有对应元素
const selectorHooks = ['data-view', 'data-phase', 'data-range', 'data-ambient'];
selectorHooks.forEach((attr) => {
  const usedInSelector = new RegExp("querySelector[All]*\\([^)]*\\[" + attr).test(app) ||
    new RegExp("\\." + attr + "\\b").test(app);
  const inHtml = html.includes(attr);
  if (usedInSelector && !inHtml) { fail++; console.log('  \u2717 ' + attr + ' 在 JS 中作为选择器使用但 HTML 中没有'); }
});
console.log('  \u2713 data-* 选择器钩子检查通过');

// 动态生成的属性（如 data-reason）只需确认 JS 里确实产出了它们
['data-reason', 'data-act', 'data-sub-act', 'data-idx'].forEach((attr) => {
  const generated = app.includes(attr + '="');
  if (!generated) { fail++; console.log('  \u2717 JS 声明使用 ' + attr + ' 但未在模板中生成'); }
});
console.log('  \u2713 动态属性生成检查通过');

// 检查 CSS 中的关键类是否被 HTML 使用
const cssClasses = [...css.matchAll(/\.([a-z][a-z0-9-]{2,})/g)].map((m) => m[1]);
const htmlClasses = new Set([...html.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/)));
const jsClasses = new Set([...app.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/)));
const unusedCritical = [...new Set(cssClasses)].filter(
  (c) => !htmlClasses.has(c) && !jsClasses.has(c) && !['is-open', 'is-active', 'is-out', 'is-dragging'].includes(c)
);
console.log('  \u2139 CSS 中未被引用的类（可能正常，多为 JS 动态添加）：' + unusedCritical.slice(0, 20).join(', '));

// 检查 HTML 里引用的静态资源是否存在
const assets = [...html.matchAll(/(?:href|src)="([^"#][^"]*)"/g)].map((m) => m[1])
  .filter((u) => !/^https?:/.test(u));
assets.forEach((a) => {
  const p = path.join(ROOT, a);
  if (!fs.existsSync(p)) { fail++; console.log('  \u2717 资源不存在：' + a); }
});
console.log('  \u2713 检查了 ' + assets.length + ' 个静态资源引用');

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.webmanifest'), 'utf8'));
manifest.icons.forEach((i) => {
  if (!fs.existsSync(path.join(ROOT, i.src))) { fail++; console.log('  \u2717 manifest 图标缺失：' + i.src); }
});
console.log('  \u2713 manifest 图标全部存在');

process.exit(fail ? 1 : 0);
