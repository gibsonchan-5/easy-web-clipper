/**
 * Easy Web Clipper - 微博专用引擎（桌面端）
 *
 * 机制说明（2026-09-20 实测）：
 * - weibo.com 主站与 m.weibo.cn 对匿名纯 HTTP 请求一律 302 到「Sina Visitor System」游客系统，
 *   需要浏览器执行 JS 签发游客 cookie 才放行——纯 HTTP 通道不可用。
 * - 系统 Chrome `--headless=new` 无头渲染可自动完成游客签发并加载内容（与知乎 zse-ck 同理）：
 *   weibo.com 渲染后 DOM 中正文在 div._wbtext_，作者在 header a[aria-label]，时间在 a._time_；
 *   m.weibo.cn 渲染后内嵌 var $render_data JSON（status: text/user/pics/created_at）。
 * - 图片 CDN（wx*.sinaimg.cn）无签名、无防盗链（无 Referer 直接 200），URL 永久有效，
 *   可直接远程引用（与知乎一致，无需本地化）；小尺寸路径段（orj360/bmiddle 等）替换为 large 取原图。
 *
 * 输入兼容：weibo.com/<uid>/<bid>、m.weibo.cn/status/<id>，以及包含链接的分享文案整段文本。
 * 限制：评论区走带签名的接口，匿名架构拿不到（同小红书）；超长文匿名态可能被「展开」截断。
 */

import { requestUrl, Vault, normalizePath } from 'obsidian';
import { renderWithLocalChrome } from './zhihu';
import type { WebClippersSettings } from './settings';
import type { XhsImageJob } from './xhs';

/** 与 extractXhsArticle 返回结构同形（clipper.ts 的 prebuilt 分支直接复用） */
export interface WeiboExtractResult {
	article: {
		title: string;
		content: string;
		textContent: string;
		excerpt: string;
		byline: string;
		length: number;
	};
	images: XhsImageJob[];
	canonicalUrl: string;
}

export function isWeiboUrl(url: string): boolean {
	try {
		const host = new URL(url).hostname.toLowerCase();
		return (
			host === 'weibo.com' ||
			host === 'www.weibo.com' ||
			host === 'm.weibo.cn' ||
			host.endsWith('.weibo.cn') ||
			host === 'weibo.cn'
		);
	} catch {
		return false;
	}
}

/** 小尺寸路径段 → large（sinaimg 的尺寸由路径段决定，文件名不变） */
function upgradeSinaImgSize(u: string): string {
	return u.replace(
		/\/(orj360|orj480|bmiddle|square|thumbnail|mw690|mw2000|small)\//,
		'/large/'
	);
}

/** 微博标题清洗：去掉「【】」包裹与话题 # 号（# 进入文件名会被 Obsidian 当标题锚点） */
function cleanTitle(raw: string): string {
	return raw.replace(/[【】#]/g, '').trim();
}

/** HTML → 纯文本（用于标题兜底 / 摘要 / 长度计算） */
function stripTags(html: string): string {
	return html
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<\/(p|div)>/gi, '\n')
		.replace(/<[^>]+>/g, '')
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

const esc = (s: string) =>
	s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 组装正文 HTML：逐行成段 + 发布时间/来源行 + 图片 + 视频说明 */
function buildContent(
	textHtml: string,
	meta: { author: string; time: string; pics: string[]; isVideo: boolean }
): string {
	const text = stripTags(textHtml);
	const paragraphs = text
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.map((line) => `<p>${esc(line)}</p>`)
		.join('\n');

	const metaLine =
		[meta.author, meta.time].filter(Boolean).join(' · ') || '';
	const metaHtml = metaLine ? `<p>（${esc(metaLine)}）</p>` : '';

	const videoNote = meta.isVideo
		? '<p>（视频微博：此处仅剪藏文字与封面，视频未下载）</p>'
		: '';

	const imgHtml = meta.pics
		.map((u, i) => `<p><img src="${u}" alt="配图${i + 1}"></p>`)
		.join('\n');

	return [paragraphs, metaHtml, videoNote, imgHtml]
		.filter(Boolean)
		.join('\n');
}

/* ---------- 路径一：m.weibo.cn 渲染后的 var $render_data JSON ---------- */

/** 从渲染 HTML 中截取 $render_data 数组并 JSON 化（括号配平 + undefined 置 null） */
function parseRenderData(html: string): Record<string, unknown> | null {
	const i = html.indexOf('var $render_data =');
	if (i < 0) return null;
	const j = html.indexOf('[', i);
	if (j < 0) return null;

	let depth = 0;
	let end = -1;
	let inStr = false;
	let escNext = false;
	for (let k = j; k < html.length; k++) {
		const ch = html[k];
		if (inStr) {
			if (escNext) escNext = false;
			else if (ch === '\\') escNext = true;
			else if (ch === '"') inStr = false;
		} else if (ch === '"') inStr = true;
		else if (ch === '[') depth++;
		else if (ch === ']') {
			depth--;
			if (depth === 0) {
				end = k;
				break;
			}
		}
	}
	if (end < 0) return null;
	try {
		const json = html.slice(j, end + 1).replace(/([:,\[]\s*)undefined\b/g, '$1null');
		const data = JSON.parse(json);
		return Array.isArray(data) ? (data[0] as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

function extractFromRenderData(html: string, url: string): WeiboExtractResult | null {
	const data = parseRenderData(html);
	const status = (data?.status as Record<string, unknown> | undefined) || undefined;
	if (!status) return null;

	const user = (status.user as Record<string, unknown> | undefined) || {};
	const author = (user.screen_name as string) || '';
	const createdAt = (status.created_at as string) || '';
	const textHtml = (status.text as string) || '';
	const text = stripTags(textHtml);
	if (!text) return null;

	// 转发的原微博：正文后附引用块
	const rt = status.retweeted_status as Record<string, unknown> | undefined;
	let rtHtml = '';
	if (rt && rt.text) {
		const rtUser = ((rt.user as Record<string, unknown>)?.screen_name as string) || '';
		rtHtml = `<p>—— 转发 ${esc(rtUser || '原微博')}：${esc(stripTags(rt.text as string))} ——</p>`;
	}

	// 图片：pics[].large.url 优先，逐级降级
	const picsRaw = (status.pics as Array<Record<string, unknown>> | undefined) || [];
	const pics = picsRaw
		.map((p) => {
			const large = (p.large as Record<string, unknown> | undefined)?.url as string;
			return (large || (p.url as string) || '').replace(/^http:\/\//i, 'https://');
		})
		.filter(Boolean)
		.map(upgradeSinaImgSize);

	// 视频：page_info.type === 'video'
	const pageInfo = (status.page_info as Record<string, unknown> | undefined) || {};
	const isVideo = pageInfo.type === 'video';

	const title =
		cleanTitle(text.split('\n')[0].slice(0, 40)) || '微博';

	return {
		article: {
			title,
			content: buildContent(textHtml + rtHtml, {
				author,
				time: createdAt,
				pics,
				isVideo,
			}),
			textContent: text,
			excerpt: text.slice(0, 200),
			byline: author,
			length: text.length,
		},
		images: pics.map((u, i) => ({
			remote: u,
			filename: `weibo-${u.split('/').pop() || `pic-${i}.jpg`}`,
		})),
		canonicalUrl: url,
	};
}

/* ---------- 路径二：weibo.com 渲染后的 DOM ---------- */

/** 截取指定 class 前缀的 div 的 innerHTML（按 div 标签配平） */
function extractDivHtml(html: string, classPrefix: string): string[] {
	const results: string[] = [];
	let from = 0;
	for (;;) {
		const marker = `<div class="${classPrefix}`;
		const start = html.indexOf(marker, from);
		if (start < 0) break;
		// 回溯到标签开头的 '<'
		const open = html.lastIndexOf('<div', start);
		let depth = 0;
		let end = -1;
		const re = /<\/?div\b[^>]*>/g;
		re.lastIndex = open;
		let m: RegExpExecArray | null;
		while ((m = re.exec(html)) !== null) {
			// 注意 m[0] 是完整标签（含 >），以 </ 开头即闭合标签
			if (m[0].startsWith('</')) depth--;
			else depth++;
			if (depth === 0) {
				end = m.index + m[0].length;
				break;
			}
		}
		if (end < 0) break;
		// 取首标签 '>' 之后的全部内容（含闭合 div 前）
		const innerStart = html.indexOf('>', open) + 1;
		results.push(html.slice(innerStart, end - '</div>'.length));
		from = end;
	}
	return results;
}

function extractFromDom(html: string, url: string): WeiboExtractResult | null {
	// 正文块：主微博 + （若有）转发引用
	const blocks = extractDivHtml(html, '_wbtext_');
	if (blocks.length === 0) return null;

	// 清洗正文块内的表情图标（<img alt="[xx]"> → 文本）与冗余空白
	const cleanBlock = (b: string) =>
		b
			.replace(/<img[^>]*alt="(\[[^\]]*\])"[^>]*>/g, '$1')
			.replace(/<img[^>]*>/g, '');

	let textHtml = cleanBlock(blocks[0]);
	if (blocks.length > 1) {
		textHtml += `<p>—— 转发内容 ——</p>${blocks
			.slice(1)
			.map(cleanBlock)
			.join('<br>')}`;
	}

	// 作者：header 中带 aria-label 的用户链接
	const author =
		html.match(/<a[^>]+href="\/\/weibo\.com\/u\/\d+"[^>]+aria-label="([^"]+)"/)?.[1] ||
		html.match(/<a[^>]+aria-label="([^"]+)"[^>]+href="\/\/weibo\.com\/u\/\d+"/)?.[1] ||
		'';

	// 时间与规范化链接：a._time_ 的文本 + href（weibo.com/<uid>/<bid> 永久形态）
	const timeAnchor =
		html.match(/<a[^>]+class="_time_[^"]*"[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/) ||
		html.match(/<a[^>]+href="([^"]+)"[^>]*class="_time_[^"]*"[^>]*>([^<]+)<\/a>/);
	const timeText = timeAnchor?.[2] || '';
	let canonical = url;
	if (timeAnchor?.[1]) {
		canonical = timeAnchor[1].startsWith('//')
			? `https:${timeAnchor[1]}`
			: timeAnchor[1];
	}

	// 图片：wx*.sinaimg.cn（排除头像 tvax、图标 h5）
	const pics = Array.from(
		new Set(
			Array.from(
				html.matchAll(/<img[^>]+src="(https:\/\/wx\d\.sinaimg\.cn\/[^"]+)"/g),
				(m) => m[1]
			)
		)
	).map(upgradeSinaImgSize);

	// 视频检测：页面常驻空的播放器壳（<video> 无 src），必须匹配带 src 或 <source> 才算真视频
	const isVideo = /<video[^>]+\ssrc=|<source\b/.test(html);

	const text = stripTags(textHtml);
	if (!text) return null;
	const title = cleanTitle(text.split('\n')[0].slice(0, 40)) || '微博';

	return {
		article: {
			title,
			content: buildContent(textHtml, { author, time: timeText, pics, isVideo }),
			textContent: text,
			excerpt: text.slice(0, 200),
			byline: author,
			length: text.length,
		},
		images: pics.map((u, i) => ({
			remote: u,
			filename: `weibo-${u.split('/').pop() || `pic-${i}.jpg`}`,
		})),
		canonicalUrl: canonical,
	};
}

/**
 * 渲染微博页面并提取正文。weibo.com 与 m.weibo.cn 分别走 DOM / JSON 提取路径。
 */
export async function extractWeiboArticle(
	url: string,
	onProgress?: (message: string) => void
): Promise<WeiboExtractResult> {
	const html = await renderWithLocalChrome(url, {
		label: '微博',
		marker: /_wbtext_|\$render_data/,
		budgetFast: 6000,
		budgetFallback: 20000,
		onProgress,
	});

	const result = html.includes('var $render_data')
		? extractFromRenderData(html, url)
		: extractFromDom(html, url);

	if (!result) {
		throw new Error('微博页面已渲染但未提取到正文：链接可能指向不支持的内容（如头条文章），或内容已删除');
	}
	return result;
}

/**
 * 微博配图本地化。sinaimg CDN 有 Referer 白名单（仅放行微博域名，空 Referer 与
 * 非微博 Referer 一律 403），Obsidian 以 app://obsidian.md 来源加载远程图片会被拒，
 * 因此与小红书同理下载到 attachments；下载时必须带微博 Referer。
 * 单张失败不中断剪藏：保留远程地址兜底（浏览器直接打开仍可见）。
 */
export async function localizeWeiboImages(
	images: XhsImageJob[],
	vault: Vault,
	settings: WebClippersSettings,
	onProgress?: (message: string) => void
): Promise<Map<string, string>> {
	const result = new Map<string, string>();
	if (images.length === 0) return result;

	const dir = normalizePath(`${settings.savePath}/attachments`);
	if (!vault.getAbstractFileByPath(dir)) {
		await vault.createFolder(dir);
	}

	for (let i = 0; i < images.length; i++) {
		const job = images[i];
		onProgress?.(`正在下载微博配图（${i + 1}/${images.length}）...`);
		const path = normalizePath(`${dir}/${job.filename}`);
		try {
			if (vault.getAbstractFileByPath(path)) {
				result.set(job.remote, path);
				continue;
			}
			const resp = await requestUrl({
				url: job.remote,
				method: 'GET',
				headers: {
					'User-Agent':
						'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
					'Referer': 'https://weibo.com/',
				},
				throw: false,
			});
			if (resp.status === 200 && resp.arrayBuffer.byteLength > 0) {
				await vault.createBinary(path, resp.arrayBuffer);
				result.set(job.remote, path);
			}
		} catch {
			// 单张失败不中断剪藏：保留远程地址，笔记中仍引用原始 URL
		}
	}

	return result;
}
