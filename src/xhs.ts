/**
 * Easy Web Clipper - 小红书笔记剪藏支持
 *
 * 机制说明（2026-09-20 实测）：
 * - 小红书是「令牌 + 登录」型反爬：不带 xsec_token 的笔记 URL 一律 302 → 404（error_code=300031），
 *   headless Chrome 也会被 SPA 路由弹回首页，因此知乎那套渲染方案在这里不适用。
 * - 用户从 App「分享→复制链接」或浏览器地址栏复制得到的 URL 天然携带 xsec_token，
 *   纯 HTTP 请求即可拿到 SSR 页面，其中 window.__INITIAL_STATE__ 包含完整笔记数据
 *   （noteDetailMap[id].note：title / desc / imageList / user / interactInfo）。
 * - 图片 CDN 匿名可下载，但图片 URL 带时间签名会过期，因此剪藏时必须把图片下载到本地。
 *
 * 输入兼容：支持完整笔记链接、xhslink.com 短链接、以及包含链接的小红书分享文案整段文本
 * （URL 由 clipper.ts 的 extractUrl 预先提取）。
 */

import { requestUrl, Vault, normalizePath } from 'obsidian';
import { WebClippersSettings } from './settings';

/** 与 clipper.ts 同款的桌面 UA（实测可过小红书 SSR） */
const XHS_UA =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export function isXhsUrl(url: string): boolean {
	try {
		const host = new URL(url).hostname.toLowerCase();
		return (
			host === 'xiaohongshu.com' ||
			host.endsWith('.xiaohongshu.com') ||
			host === 'xhslink.com' ||
			host.endsWith('.xhslink.com')
		);
	} catch {
		return false;
	}
}

/** 剪藏所需的图片任务：远程地址 + 建议的本地文件名 */
export interface XhsImageJob {
	remote: string;
	filename: string;
}

/** 提取结果：与 extractArticle 同形的 article + 待本地化图片列表 + 规范化来源链接 */
export interface XhsExtractResult {
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

/** 从 SSR HTML 中截取 window.__INITIAL_STATE__ 并解析为对象（容忍 JS 的 undefined 值） */
function parseInitialState(html: string): Record<string, unknown> | null {
	const m = html.match(/window\.__INITIAL_STATE__=([\s\S]*?)<\/script>/);
	if (!m) return null;
	// JSON 化：仅把「值位置」的 undefined 置为 null，避免误伤正文里出现的 undefined 字样
	const json = m[1].replace(/([:,\[]\s*)undefined\b/g, '$1null');
	try {
		return JSON.parse(json);
	} catch {
		return null;
	}
}

/** 从图片条目的多档 URL 里挑最清晰的一档，并统一升级为 https */
function pickImageUrl(img: Record<string, unknown>): string {
	const infoList = (img.infoList as Array<Record<string, unknown>> | undefined) || [];
	const dft = infoList.find((s) => s.imageScene === 'WB_DFT');
	const last = infoList[infoList.length - 1];
	const raw =
		(dft?.url as string) ||
		(last?.url as string) ||
		(img.url as string) ||
		(img.urlPre as string) ||
		(img.urlDefault as string) ||
		'';
	return raw ? raw.replace(/^http:\/\//i, 'https://') : '';
}

/** 清理 desc 文本：去除 [话题] 标记、小红书表情码（[微笑R] 等）、折叠多余空行 */
function cleanDesc(desc: string): string {
	return desc
		.replace(/\[话题\]#/g, '')
		.replace(/\[[^\[\]]{1,8}R\]/g, '')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

/**
 * 抓取并解析小红书笔记，返回与 extractArticle 同形的结构。
 * 支持 www.xiaohongshu.com 完整链接与 xhslink.com 短链接（requestUrl 自动跟随重定向）。
 */
export async function extractXhsArticle(
	url: string,
	onProgress?: (message: string) => void
): Promise<XhsExtractResult> {
	const response = await requestUrl({
		url,
		method: 'GET',
		headers: {
			'User-Agent': XHS_UA,
			'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
			'Accept-Language': 'zh-CN,zh;q=0.9',
		},
		throw: false,
	});

	if (response.status !== 200) {
		throw new Error(
			`小红书返回 HTTP ${response.status}。请确认粘贴的是「分享→复制链接」得到的完整链接（需带 xsec_token），链接可能已失效`
		);
	}

	const state = parseInitialState(response.text);
	// noteDetailMap 在 state.note 分片下（新路径），兜底兼容顶层旧结构
	const noteState = (state?.note as Record<string, unknown> | undefined) || {};
	const map =
		(noteState.noteDetailMap as Record<string, Record<string, unknown>> | undefined) ||
		(state?.noteDetailMap as Record<string, Record<string, unknown>> | undefined) ||
		{};
	const entry = Object.values(map)[0] as Record<string, unknown> | undefined;
	const note = entry?.note as Record<string, unknown> | undefined;
	if (!note) {
		throw new Error('页面中未找到笔记数据：链接可能失效，或粘贴的不是笔记详情页链接');
	}

	const noteId = (note.noteId as string) || '';
	const xsecToken = (note.xsecToken as string) || '';
	const type = (note.type as string) || 'normal';
	const desc = cleanDesc((note.desc as string) || '');
	const nickname = ((note.user as Record<string, unknown> | undefined)?.nickname as string) || '';
	const rawTitle = ((note.title as string) || '').trim();

	// 标题兜底：部分笔记没有独立标题，取 desc 首行
	const title =
		rawTitle ||
		(desc.split('\n')[0] || '').slice(0, 40).trim() ||
		'小红书笔记';

	// 收集图片（视频笔记的 imageList 首项即封面）
	const images: XhsImageJob[] = [];
	const imgList = (note.imageList as Array<Record<string, unknown>>) || [];
	imgList.forEach((img, i) => {
		const remote = pickImageUrl(img);
		if (!remote) return;
		images.push({
			remote,
			filename: `xhs-${noteId.slice(0, 8) || Date.now()}-${i}.jpg`,
		});
	});

	// 组装正文 HTML：desc 逐行成段 + 图片
	const esc = (s: string) =>
		s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	const paragraphs = desc
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.map((line) => `<p>${esc(line)}</p>`)
		.join('\n');

	const imgHtml = images
		.map((im, i) => `<p><img src="${im.remote}" alt="配图${i + 1}"></p>`)
		.join('\n');

	const videoNote =
		type === 'video'
			? '<p>（视频笔记：此处剪藏封面与文字，视频内容未下载）</p>'
			: '';

	const content = [paragraphs, videoNote, imgHtml].filter(Boolean).join('\n');

	// 规范化来源链接：短链接会过期，用 noteId + xsecToken 重建永久形态
	const canonicalUrl =
		noteId && xsecToken
			? `https://www.xiaohongshu.com/explore/${noteId}?xsec_token=${xsecToken}&xsec_source=pc_share`
			: url;

	return {
		article: {
			title,
			content,
			textContent: desc,
			excerpt: desc.slice(0, 200),
			byline: nickname,
			length: desc.length,
		},
		images,
		canonicalUrl,
	};
}

/**
 * 把笔记图片下载到本地（小红书图片 URL 带时效签名，必须立即本地化）。
 * 保存在「savePath/attachments」下；同名文件已存在则直接复用。
 * 返回 远程地址 → 本地 vault 路径 的映射。
 */
export async function localizeXhsImages(
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
		onProgress?.(`正在下载笔记图片（${i + 1}/${images.length}）...`);
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
					'User-Agent': XHS_UA,
					'Referer': 'https://www.xiaohongshu.com/',
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
