import test from 'node:test';
import { stripImageEmbeds } from '../src/js/markdown.js';
import assert from 'node:assert';

import { render, inline, plainLines, escapeHtml } from '../src/js/markdown.js';

test('行内：双链区分存在与缺失', () => {
  const html = inline('看 [[甲]] 和 [[乙]]', (t) => t === '甲');
  assert.match(html, /class="wl" data-title="甲"/);
  assert.match(html, /class="wl missing" data-title="乙"/);
});

test('行内：粗体 / 斜体 / 删除线 / 代码', () => {
  assert.equal(inline('**粗**'), '<strong>粗</strong>');
  assert.equal(inline('*斜*'), '<em>斜</em>');
  assert.equal(inline('~~删~~'), '<del>删</del>');
  assert.equal(inline('`x<y`'), '<code>x&lt;y</code>');
});

test('行内：标签带前导空格不吞字', () => {
  assert.equal(inline('看看 #标签'), '看看 <span class="tag" data-tag="标签">#标签</span>');
});

test('行内：HTML 被转义', () => {
  assert.equal(inline('<img src=x>'), '&lt;img src=x&gt;');
  assert.equal(escapeHtml('a&b'), 'a&amp;b');
});

test('行内：嵌套强调不会把正则搞死（回归）', () => {
  const html = inline('**粗 *斜* 粗**');
  assert.match(html, /<strong>粗 <em>斜<\/em> 粗<\/strong>/);
});

test('公式：没有 KaTeX 时原样显示，不吞内容', () => {
  const html = inline('算力 $CI = \\text{FLOPs} / \\text{Bytes}$ 到此');
  assert.match(html, /\$CI = \\text\{FLOPs\} \/ \\text\{Bytes\}\$/);
});

test('公式：有 KaTeX 就渲染，且 $ 里的 * 不当斜体', () => {
  globalThis.katex = {
    renderToString: (tex, opts) => `<span class="katex" data-display="${opts.displayMode}">${tex}</span>`,
  };
  try {
    assert.match(inline('$x^2$'), /class="katex" data-display="false">x\^2</);
    assert.equal(inline('$a*b$').includes('<em>'), false);
    const block = render('$$\n\\int_0^1 x dx\n$$');
    assert.match(block, /math-block/);
    assert.match(block, /data-display="true"/);
  } finally {
    delete globalThis.katex;
  }
});

test('行内：下划线强调与反斜杠转义', () => {
  assert.equal(inline('_斜_'), '<em>斜</em>');
  assert.equal(inline('__粗__'), '<strong>粗</strong>');
  assert.equal(inline('snake_case_name'), 'snake_case_name'); // 不能把变量名吃掉
  assert.equal(inline('a \\* b'), 'a * b');
});

test('引用：多行用真换行，不能出现字面 <br>', () => {
  const html = render('> 甲\n> 乙');
  assert.equal(html, '<blockquote>甲<br>乙</blockquote>');
  assert.equal(html.includes('&lt;br&gt;'), false);
});

test('列表：按缩进排嵌套', () => {
  const html = render('- 一\n  - 二\n    - 三');
  assert.match(html, /<li>一<\/li>/);
  assert.match(html, /<li style="margin-left:20px">二<\/li>/);
  assert.match(html, /<li style="margin-left:40px">三<\/li>/);
});

test('表格：对齐标记生效', () => {
  const html = render('| a | b |\n| :--- | ---: |\n| 1 | 2 |');
  assert.match(html, /<th style="text-align:left">a<\/th>/);
  assert.match(html, /<td style="text-align:right">2<\/td>/);
});

test('块：标题 / 列表 / 引用 / 代码 / 表格 / 分隔线', () => {
  const html = render([
    '# 一级', '', '- 甲', '- 乙', '', '1. 一', '2. 二', '',
    '> 引用', '', '```', 'code', '```', '',
    '| a | b |', '| --- | --- |', '| 1 | 2 |', '', '---', '',
  ].join('\n'));
  assert.match(html, /<h1>一级<\/h1>/);
  assert.match(html, /<ul><li>甲<\/li><li>乙<\/li><\/ul>/);
  assert.match(html, /<ol><li>一<\/li><li>二<\/li><\/ol>/);
  assert.match(html, /<blockquote>引用<\/blockquote>/);
  assert.match(html, /<pre><code>code<\/code><\/pre>/);
  assert.match(html, /<table>/);
  assert.match(html, /<hr>/);
});

test('块：任务清单', () => {
  const html = render('- [x] 完成\n- [ ] 未完成');
  assert.match(html, /type="checkbox" disabled checked/);
  assert.match(html, /type="checkbox" disabled >/);
});

test('图片：![[文件名]] 渲染成图，路径不出现在界面上', () => {
  const html = inline('![[img-abc.png]]');
  assert.match(html, /<img class="note-img"/);
  assert.match(html, /src="fyn-img:\/\/local\/img-abc\.png"/);
  assert.equal(html.includes('image/'), false);
});

test('图片：不是图片扩展名时仍按双链处理', () => {
  const html = inline('![[知识图谱]]', (t) => t === '知识图谱');
  assert.match(html, /class="wl"/);
  assert.equal(html.includes('<img'), false);
});

test('图片：![](xxx) 支持，外链原样保留', () => {
  const ok = inline('![](image/pic.webp)');
  assert.match(ok, /src="fyn-img:\/\/local\/pic\.webp"/);
  const http = inline('![x](https://example.com/a.png)');
  assert.equal(http.includes('<img'), false);
  assert.match(http, /https:\/\/example\.com\/a\.png/);
});

test('摘要：图片显示成 [图片 文件名]', () => {
  const lines = plainLines('![[img-abc.png]]\n正常一行');
  assert.deepEqual(lines, ['[图片 img-abc.png]', '正常一行']);
});

test('纯文本行：去掉标记', () => {
  const lines = plainLines('## 标题\n**粗**与[[链接]] #标签\n\n- 条目');
  assert.deepEqual(lines, ['标题', '粗与链接', '条目']);
});

test('卡片用的去图：图片嵌入被去掉，笔记双链保留', () => {
  assert.equal(stripImageEmbeds('文字\n\n![[img-1.png]]\n\n结尾').trim(), '文字\n\n\n\n结尾'.trim());
  assert.equal(stripImageEmbeds('![[笔记标题]] 保留'), '![[笔记标题]] 保留');
  assert.equal(stripImageEmbeds('![alt](http://x/y.png)').trim(), '');
  assert.equal(stripImageEmbeds('![[a.JPG]]'), '');
  assert.equal(stripImageEmbeds(''), '');
});
