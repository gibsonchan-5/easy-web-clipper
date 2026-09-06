/**
 * Easy Web Clipper - 核心剪藏逻辑
 * 
 * 负责:
 * - 抓取网页内容
 * - 使用 Readability.js 提取正文
 * - 清洗 HTML (去除广告、导航、页脚等)
 * - 使用 Turndown 转换为 Markdown
 * - 保存到 Obsidian
 */

import { requestUrl, Notice, Vault, normalizePath, TFile } from 'obsidian';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { WebClippersSettings } from './settings';

/**
 * 抓取网页 HTML
 */
export async function fetchWebPage(url: string): Promise<string> {
  try {
    const response = await requestUrl({
      url,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      throw: false,
    });

    if (response.status !== 200) {
      throw new Error(`HTTP ${response.status}: ${response.statusText || '请求失败'}`);
    }

    return response.text;
  } catch (error) {
    throw new Error(`抓取网页失败: ${error.message}`);
  }
}

/**
 * 后清洗：对 Readability / 微信提取器输出的 HTML 做二次清理
 * 去除备案号、版权声明、多余空段落、占位元素等
 */
function cleanExtractedContent(html: string, url: string): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  // 判断元素是否"视觉为空"：忽略 NBSP(\u00a0)、全角空格(\u3000)、零宽字符(\u200b-\u200d)、纯 <br>
  const isVisuallyEmpty = (el: Element): boolean => {
    if (el.querySelector('img, video, audio, canvas, svg, pre, code')) return false;
    const text = el.textContent || '';
    const stripped = text.replace(/[\s\u00a0\u3000\u200b-\u200d\ufeff]/g, '');
    if (stripped.length > 0) return false;
    const nonBr = Array.from(el.children).filter(
      (c) => c.tagName.toLowerCase() !== 'br'
    );
    return nonBr.length === 0;
  };

  // 移除备案号
  doc.querySelectorAll('p, div, section').forEach((el) => {
    const text = el.textContent?.trim() || '';
    if (/^(京|沪|粤|浙|苏|鲁|川|渝|鄂|湘|豫|冀|闽|皖|赣|陕|黔|滇|黑|吉|辽|晋|蒙|新|藏|青|宁|甘|桂|津)?ICP(备|证)?\d+/.test(text)) {
      el.remove();
    }
  });

  // 移除版权声明
  doc.querySelectorAll('p, div').forEach((el) => {
    const text = el.textContent?.trim() || '';
    if (/^(Copyright|版权所有|All Rights Reserved)/i.test(text)) {
      el.remove();
    }
  });

  // 移除视觉为空的块级元素（扩展 selector 覆盖 article/aside/figure 等容器）
  doc.querySelectorAll(
    'div, section, article, aside, main, header, footer, figure, figcaption, blockquote, ' +
      'p, span, ul, ol, li, h1, h2, h3, h4, h5, h6, table, tr, td, th'
  ).forEach((el) => {
    if (isVisuallyEmpty(el)) el.remove();
  });

  // 移除"高度撑开但无可见文本"的 spacer
  doc.querySelectorAll('[style*="height" i]').forEach((el) => {
    if (isVisuallyEmpty(el)) el.remove();
  });

  // 移除空 src / 1x1 透明占位图
  doc.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src') || '';
    if (!src) {
      img.remove();
      return;
    }
    if (/data:image\/gif;base64,R0lGODlhAQABAIAAAP\/\/\/yH5BAEAAAAALAAAAAABAAEAAAIBRAA7/i.test(src)) {
      img.remove();
      return;
    }
    const w = img.getAttribute('width');
    const h = img.getAttribute('height');
    if (w === '1' && h === '1') img.remove();
  });

  // 移除过短的段落（可能是导航残留）
  doc.querySelectorAll('p').forEach((p) => {
    const text = (p.textContent || '').replace(/[\s\u00a0\u3000\u200b-\u200d\ufeff]/g, '');
    if (text.length > 0 && text.length < 8 && !p.querySelector('a, strong, em, code, img')) {
      p.remove();
    }
  });

  // 清理空链接和锚点链接
  doc.querySelectorAll('a').forEach((a) => {
    const href = a.getAttribute('href') || '';
    if (!href || href === '#' || href.startsWith('javascript:')) {
      a.replaceWith(...Array.from(a.childNodes));
    }
  });

  return doc.body?.innerHTML || html;
}

/**
 * 提取页面标题（从各种 meta 标签中获取）
 */
function extractTitle(doc: Document): string {
  // 优先 og:title
  const ogTitle = doc.querySelector('meta[property="og:title"]');
  if (ogTitle?.getAttribute('content')?.trim()) {
    return ogTitle.getAttribute('content')!.trim();
  }
  // 然后 <title>
  const titleEl = doc.querySelector('title');
  if (titleEl?.textContent?.trim()) {
    return titleEl.textContent.trim();
  }
  return '无标题';
}

/**
 * 提取文章作者
 */
function extractAuthor(doc: Document): string {
  // 微信公众号：profile_nickname
  const wxAuthor = doc.querySelector('.rich_media_meta_nickname, #js_name, .rich_media_meta_text');
  if (wxAuthor?.textContent?.trim()) {
    return wxAuthor.textContent.trim();
  }
  // 通用：article:author
  const ogAuthor = doc.querySelector('meta[property="article:author"]');
  if (ogAuthor?.getAttribute('content')?.trim()) {
    return ogAuthor.getAttribute('content')!.trim();
  }
  return '';
}

/**
 * 微信公众号文章专用提取器
 * 微信文章结构特殊，Readability 经常提取失败
 */
function extractWeixinArticle(doc: Document, url: string): {
  title: string;
  content: string;
  textContent: string;
  excerpt: string;
  byline: string;
  length: number;
} | null {
  // 微信文章正文在 #js_content 内
  const contentEl = doc.getElementById('js_content');
  if (!contentEl) return null;

  // 克隆一份避免修改原始 DOM
  const clone = contentEl.cloneNode(true) as HTMLElement;

  // 清理微信文章中的非正文元素
  const selectorsToRemove = [
    '#qr_code', '.qr_code_pc',  // 二维码
    '.reward_area', '#content_bottom_area',  // 打赏
    '.ct_mpda_wrp',  // 底部广告
    '#js_temp_bottom_area',  // 临时底部区域
    '.mp_profile_iframe_wrp',  // 作者名片 iframe
    '#js_sg_bar',  // 分享栏
    '.page_footer', '.footer',  // 页脚
    '#js_article_comment',  // 评论区
    'script', 'style', 'noscript', 'iframe', 'svg:not([data-type])',
  ];
  for (const selector of selectorsToRemove) {
    clone.querySelectorAll(selector).forEach(el => el.remove());
  }

  // 提取图片：微信图片通常用 data-src 而非 src（懒加载）
  clone.querySelectorAll('img').forEach(img => {
    const dataSrc = img.getAttribute('data-src');
    if (dataSrc) {
      img.setAttribute('src', dataSrc);
    }
    // 设置 max-width 防止过宽
    img.style.maxWidth = '100%';
    img.style.height = 'auto';
    // 移除不必要的属性
    img.removeAttribute('data-src');
    img.removeAttribute('data-ratio');
    img.removeAttribute('data-w');
    img.removeAttribute('data-origtype');
    img.removeAttribute('class');
  });

  // 清理内联样式（保留必要的排版样式）
  clone.querySelectorAll('*').forEach(el => {
    const htmlEl = el as HTMLElement;
    // 移除微信特有的内联样式属性
    htmlEl.removeAttribute('data-min');
    htmlEl.removeAttribute('data-max');
    htmlEl.removeAttribute('data-pluginname');
    htmlEl.removeAttribute('data-lazy');
  });

  const content = clone.innerHTML;
  const textContent = clone.textContent || '';

  if (textContent.trim().length < 50) {
    return null;
  }

  return {
    title: extractTitle(doc),
    content,
    textContent,
    excerpt: textContent.substring(0, 200),
    byline: extractAuthor(doc),
    length: textContent.length,
  };
}

/**
 * 把懒加载图片的 data-src / data-original 等属性提升为 src。
 * 很多站点（人民网、新华网等）正文图只有 data-src、没有 src，
 * 不提前提升会被 Readability / Turndown 当作"不可加载图片"丢弃。
 */
function resolveLazyImages(doc: Document, baseUrl: string): void {
  const LAZY_ATTRS = [
    'data-src', 'data-original', 'data-lazy-src', 'data-actualsrc',
    'data-url', 'data-echo', 'data-original-src', 'data-src-original',
  ];
  doc.querySelectorAll('img').forEach((img) => {
    const cur = img.getAttribute('src') || '';
    // 已有真实 src 就跳过；1x1 占位 GIF / data:image 占位则继续找真图
    const isPlaceholder = !cur ||
      cur === 'about:blank' ||
      cur.startsWith('data:image/gif') ||
      (cur.startsWith('data:image') && cur.length < 100);
    if (!isPlaceholder) return;

    for (const attr of LAZY_ATTRS) {
      const lazy = img.getAttribute(attr);
      if (!lazy || lazy === 'about:blank' || lazy.startsWith('data:image') && lazy.length < 100) continue;
      // 相对地址用页面 URL 补全为绝对地址
      if (/^https?:\/\//i.test(lazy)) {
        img.setAttribute('src', lazy);
      } else {
        try {
          img.setAttribute('src', new URL(lazy, baseUrl).href);
        } catch {
          img.setAttribute('src', lazy);
        }
      }
      img.removeAttribute(attr);
      break;
    }
  });
}

/**
 * 使用 Readability 提取正文
 */
export function extractArticle(html: string, url: string): {
  title: string;
  content: string;
  textContent: string;
  excerpt: string;
  byline: string;
  length: number;
} | null {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    // 设置 base URL 以处理相对路径
    const base = doc.createElement('base');
    base.setAttribute('href', url);
    doc.head?.appendChild(base);

    // 先提升懒加载图片 src，避免 Readability 丢弃正文图
    resolveLazyImages(doc, url);

    // 先尝试微信公众号专用提取器（微信文章结构特殊，Readability 经常失败）
    if (url.includes('mp.weixin.qq.com')) {
      const wxArticle = extractWeixinArticle(doc, url);
      if (wxArticle) return wxArticle;
    }

    // Readability 提取（不做 cleanHTML 预处理，让 Readability 自己判断）
    const reader = new Readability(doc, {
      charThreshold: 100,
      classesToPreserve: '',
    });

    const article = reader.parse();
    
    if (!article) {
      return null;
    }

    return {
      title: article.title || extractTitle(doc),
      content: article.content,
      textContent: article.textContent,
      excerpt: article.excerpt || '',
      byline: article.byline || extractAuthor(doc),
      length: article.length,
    };
  } catch (error) {
    console.error('Readability 解析失败:', error);
    return null;
  }
}

/**
 * 将 HTML 转换为 Markdown
 */
export function htmlToMarkdown(html: string, settings: WebClippersSettings): string {
  const turndownService = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
    bulletListMarker: '-',
    hr: '---',
  });

  // 使用 GFM 插件支持表格、删除线、任务列表
  turndownService.use(gfm);

  // 自定义规则: 图片处理
  turndownService.addRule('imageHandler', {
    filter: 'img',
    replacement: (content, node) => {
      const img = node as HTMLImageElement;
      // src 缺失时用懒加载属性兜底（data-src / data-original / data-lazy-src 等）
      let src = img.getAttribute('src') || '';
      if (!src) {
        src = img.getAttribute('data-src') ||
          img.getAttribute('data-original') ||
          img.getAttribute('data-lazy-src') ||
          img.getAttribute('data-actualsrc') ||
          img.getAttribute('data-url') || '';
      }
      const alt = img.getAttribute('alt') || '';
      
      if (!src) return '';
      
      // Obsidian 格式: ![[image.png]]
      // 标准 Markdown: ![alt](src)
      if (settings.imageStyle === 'obsidian') {
        // 提取文件名
        const filename = src.split('/').pop() || src;
        return `![${alt}](${filename})`;
      }
      
      return `![${alt}](${src})`;
    },
  });

  // 自定义规则: 移除空链接
  turndownService.addRule('emptyLinkRemoval', {
    filter: (node) => {
      if (node.nodeName !== 'A') return false;
      const anchor = node as HTMLAnchorElement;
      const href = anchor.getAttribute('href');
      return !href || href === '#' || href === 'javascript:void(0)';
    },
    replacement: (content) => content,
  });

  // 自定义规则: 移除锚点链接(只保留文本)
  turndownService.addRule('anchorLinkRemoval', {
    filter: (node) => {
      if (node.nodeName !== 'A') return false;
      const anchor = node as HTMLAnchorElement;
      const href = anchor.getAttribute('href') || '';
      return href.startsWith('#');
    },
    replacement: (content) => content,
  });

  // 转换 HTML
  let markdown = turndownService.turndown(html);

  // 清理多余的空行（连续 3+ 折成 2 个换行）
  markdown = markdown.replace(/\n{3,}/g, '\n\n');
  // 去掉末尾的连续空行 / 空段落（修复 Obsidian 阅读模式把末尾空段渲染成大块留白的问题）
  markdown = markdown.replace(/(?:\n[ \t\u00a0\u3000]*)+$/g, '');
  if (markdown.length > 0 && !markdown.endsWith('\n')) markdown += '\n';

  return markdown;
}

/**
 * 生成文件名
 */
export function generateFileName(title: string, template: string): string {
  const date = new Date();
  const dateStr = date.toISOString().split('T')[0];
  const timeStr = date.toTimeString().slice(0, 5).replace(':', '');

  let fileName = template
    .replace('{{title}}', title)
    .replace('{{date}}', dateStr)
    .replace('{{time}}', timeStr);

  // 清理文件名中的非法字符
  fileName = fileName
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();

  // 限制文件名长度
  if (fileName.length > 100) {
    fileName = fileName.substring(0, 100);
  }

  return `${fileName}.md`;
}

/**
 * 生成 Front Matter
 */
export function generateFrontMatter(
  title: string,
  url: string,
  settings: WebClippersSettings,
  excerpt?: string,
  byline?: string
): string {
  if (!settings.includeFrontMatter) return '';

  const lines: string[] = ['---'];
  
  lines.push(`title: "${title.replace(/"/g, '\\"')}"`);
  
  if (settings.includeSourceUrl) {
    lines.push(`source: ${url}`);
  }
  
  if (settings.includeClipDate) {
    lines.push(`date: ${new Date().toISOString()}`);
  }
  
  if (byline) {
    lines.push(`author: "${byline.replace(/"/g, '\\"')}"`);
  }
  
  if (excerpt) {
    lines.push(`description: "${excerpt.replace(/"/g, '\\"').substring(0, 200)}"`);
  }
  
  lines.push('tags: [web-clip]');
  lines.push('---\n');

  return lines.join('\n');
}

/**
 * 保存笔记到 Obsidian
 */
export async function saveNote(
  vault: Vault,
  filePath: string,
  content: string
): Promise<TFile> {
  const normalizedPath = normalizePath(filePath);
  
  // 自动创建目标文件夹
  const lastSlash = normalizedPath.lastIndexOf('/');
  if (lastSlash > 0) {
    const dir = normalizedPath.substring(0, lastSlash);
    const existingDir = vault.getAbstractFileByPath(dir);
    if (!existingDir) {
      await vault.createFolder(dir);
    }
  }
  
  // 检查文件是否已存在
  const existingFile = vault.getAbstractFileByPath(normalizedPath);
  if (existingFile) {
    // 如果文件已存在,添加时间戳
    const timestamp = Date.now();
    const ext = filePath.endsWith('.md') ? '.md' : '';
    const baseName = filePath.slice(0, -ext.length || undefined);
    filePath = `${baseName}_${timestamp}${ext}`;
  }

  return await vault.create(filePath, content);
}

/**
 * 从文本中提取 URL
 */
export function extractUrl(text: string): string | null {
  const urlRegex = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/g;
  const match = text.match(urlRegex);
  return match ? match[0] : null;
}

/**
 * 完整的剪藏流程
 */
export async function clipWebPage(
  url: string,
  vault: Vault,
  settings: WebClippersSettings,
  onProgress?: (message: string) => void
): Promise<TFile> {
  try {
    // 1. 抓取网页
    onProgress?.('正在抓取网页内容...');
    const html = await fetchWebPage(url);

    // 2. 提取正文（先提取，后清洗，避免误删正文元素）
    onProgress?.('正在提取正文...');
    const article = extractArticle(html, url);
    
    if (!article) {
      throw new Error('无法提取网页正文,该页面可能需要 JavaScript 渲染或不支持');
    }

    if (article.length < 100) {
      throw new Error('提取的内容过少,可能不是有效的文章页面');
    }

    // 3. 后清洗（在 Readability 输出上清洗，不影响提取效果）
    onProgress?.('正在清洗页面内容...');
    const cleanedContent = cleanExtractedContent(article.content, url);

    // 4. 转换为 Markdown
    onProgress?.('正在转换为 Markdown...');
    const markdown = htmlToMarkdown(cleanedContent, settings);

    // 5. 生成完整内容
    const frontMatter = generateFrontMatter(
      article.title,
      url,
      settings,
      article.excerpt,
      article.byline
    );
    
    const fullContent = frontMatter + markdown;

    // 6. 保存笔记
    onProgress?.('正在保存笔记...');
    const fileName = generateFileName(article.title, settings.fileNameTemplate);
    const filePath = `${settings.savePath}/${fileName}`;
    
    const file = await saveNote(vault, filePath, fullContent);

    return file;
  } catch (error) {
    throw error;
  }
}
