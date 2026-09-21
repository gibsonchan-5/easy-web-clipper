/**
 * Easy Web Clipper - B站视频剪藏支持
 *
 * 机制说明（2026-09-21 实测）：
 * - 视频信息：view API（无需登录）返回标题/UP主/简介/分P列表，国内直连即可。
 * - 字幕链路：player/v2 返回字幕轨道列表。实测未登录（含游客 cookie）subtitles 恒为空数组
 *   （AI 字幕与大部分场景需要登录态），因此设置面板提供可选的 SESSDATA（用户从浏览器复制，
 *   仅存本地），配置后即可拿到字幕轨道（CC 与 AI 均可）。
 * - 字幕文件：subtitle_url 为 `//aisubtitle.hdslb.com/...` 协议相对地址，补 https 后
 *   直接 GET（CDN 无鉴权），JSON 格式 { body: [{ from, to, content }] }（单位秒）。
 * - 无字幕时降级：不报错，输出嵌入播放器 + UP主简介，并注明原因（与 YouTube 的报错策略不同，
 *   因为 B 站游客场景无字幕的比例远高于 YouTube）。
 * - 字幕语义分段与微软机翻复用 youtube.ts 的实现（与 YouTube 剪藏保持一致）。
 * - 嵌入播放器：player.bilibili.com iframe（Obsidian 阅读视图直接渲染，可点击播放）。
 */

import { requestUrl } from 'obsidian';
import { WebClippersSettings } from './settings';
import { groupTranscript, translateTexts, fmtTime, fmtDuration } from './youtube';

const BILI_UA =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** 提取结果：与 extractYoutubeArticle 同形 */
export interface BilibiliExtractResult {
	article: {
		title: string;
		content: string;
		textContent: string;
		excerpt: string;
		byline: string;
		length: number;
	};
	images: never[];
	canonicalUrl: string;
	markdown: string;
}

interface BiliSubtitleTrack {
	lan: string;
	lan_doc?: string;
	subtitle_url?: string;
	ai_type?: number; // 0 = CC 字幕，1 = AI 字幕
}

export function isBilibiliUrl(url: string): boolean {
	try {
		const host = new URL(url).hostname.toLowerCase();
		return host === 'bilibili.com' || host.endsWith('.bilibili.com') || host === 'b23.tv' || host.endsWith('.b23.tv');
	} catch {
		return false;
	}
}

/** 从链接里提取 BV 号（/video/BVxxx）或 av 号（/video/av123），支持 b23.tv 前置判断 */
function extractIdFromPath(pathname: string): { bvid?: string; aid?: string; page: number } | null {
	const m = pathname.match(/\/video\/(BV[\w]+)/i);
	if (m) return { bvid: m[1], page: 1 };
	const a = pathname.match(/\/video\/av(\d+)/i);
	if (a) return { aid: a[1], page: 1 };
	return null;
}

/** 解析链接中的分 P 参数（?p=2） */
function extractPageNumber(url: string): number {
	try {
		const p = new URL(url).searchParams.get('p');
		const n = p ? parseInt(p, 10) : 1;
		return n >= 1 ? n : 1;
	} catch {
		return 1;
	}
}

/**
 * 解析视频 ID。b23.tv 短链优先从路径直接解析（官方支持 b23.tv/BVxxx 与 b23.tv/av123 形态）；
 * 随机短码则抓一次跳转页，从 HTML 里提取真实视频地址。
 * 返回 { bvid } 或 { aid }；失败返回 null。
 */
async function resolveVideoId(url: string): Promise<{ bvid?: string; aid?: string; page: number } | null> {
	let direct = extractIdFromPath(url);
	if (direct) return { ...direct, page: extractPageNumber(url) };

	try {
		const host = new URL(url).hostname.toLowerCase();
		if (host === 'b23.tv' || host.endsWith('.b23.tv')) {
			// 短链路径直接是 BV/av 号的形态（无需网络请求）
			const pathId = new URL(url).pathname.match(/^\/(BV[\w]+|av\d+)/i);
			if (pathId) {
				const parsed = extractIdFromPath(`/video/${pathId[1]}`);
				if (parsed) return { ...parsed, page: extractPageNumber(url) };
			}
			// 随机短码：抓跳转页，从页面内容里提取真实地址
			const resp = await requestUrl({
				url,
				method: 'GET',
				headers: { 'User-Agent': BILI_UA },
				throw: false,
			});
			const m = resp.text.match(/https?:\/\/(?:www\.)?bilibili\.com\/video\/(BV[\w]+|av\d+)/i);
			if (m) {
				const parsed = extractIdFromPath(m[0]);
				if (parsed) return { ...parsed, page: extractPageNumber(m[0]) };
			}
		}
	} catch {
		// 短链解析失败，走统一报错
	}
	return null;
}

/** B站 API 统一请求头（UA + Referer 必须） */
function biliHeaders(sessdata?: string): Record<string, string> {
	const headers: Record<string, string> = {
		'User-Agent': BILI_UA,
		Referer: 'https://www.bilibili.com/',
	};
	if (sessdata && sessdata.trim()) {
		headers.Cookie = `SESSDATA=${sessdata.trim()}`;
	}
	return headers;
}

/** 调 view API 拿视频信息（无需登录） */
async function fetchViewInfo(id: { bvid?: string; aid?: string }): Promise<Record<string, unknown>> {
	const param = id.bvid ? `bvid=${encodeURIComponent(id.bvid)}` : `aid=${id.aid}`;
	const resp = await requestUrl({
		url: `https://api.bilibili.com/x/web-interface/view?${param}`,
		method: 'GET',
		headers: biliHeaders(),
		throw: false,
	});
	if (resp.status !== 200) {
		throw new Error(`B站接口返回 HTTP ${resp.status}，请稍后重试`);
	}
	const data = resp.json as Record<string, unknown>;
	if (data.code !== 0) {
		throw new Error(`B站视频获取失败：${(data.message as string) || `错误码 ${data.code}`}`);
	}
	return data.data as Record<string, unknown>;
}

/** 调 player/v2 拿字幕轨道列表（游客恒为空；带 SESSDATA 可拿 CC 与 AI 字幕） */
async function fetchSubtitleTracks(
	id: { bvid?: string; aid?: string },
	cid: number,
	sessdata?: string
): Promise<BiliSubtitleTrack[]> {
	const param = id.bvid ? `bvid=${encodeURIComponent(id.bvid)}` : `aid=${id.aid}`;
	const resp = await requestUrl({
		url: `https://api.bilibili.com/x/player/v2?${param}&cid=${cid}`,
		method: 'GET',
		headers: biliHeaders(sessdata),
		throw: false,
	});
	if (resp.status !== 200) return [];
	try {
		const data = resp.json as Record<string, unknown>;
		if (data.code !== 0) return [];
		const subtitle = (data.data as Record<string, unknown> | undefined)?.subtitle as
			| Record<string, unknown>
			| undefined;
		const tracks = (subtitle?.subtitles as BiliSubtitleTrack[] | undefined) || [];
		return tracks.filter((t) => t.subtitle_url);
	} catch {
		return [];
	}
}

/** 选字幕轨道：CC 优先于 AI；语言 zh > en > 首个 */
function pickTrack(tracks: BiliSubtitleTrack[]): BiliSubtitleTrack | null {
	if (tracks.length === 0) return null;
	const preferred = (arr: BiliSubtitleTrack[]) =>
		arr.find((t) => t.lan.toLowerCase().startsWith('zh')) ||
		arr.find((t) => t.lan.toLowerCase().startsWith('en')) ||
		arr[0];
	const cc = tracks.filter((t) => t.ai_type !== 1);
	const ai = tracks.filter((t) => t.ai_type === 1);
	return preferred(cc) || preferred(ai) || null;
}

/** 字幕 JSON → { 起始ms, 文本 }[] */
function parseSubtitleJson(text: string): Array<{ startMs: number; text: string }> {
	try {
		const data = JSON.parse(text) as {
			body?: Array<{ from?: number; content?: string }>;
		};
		const out: Array<{ startMs: number; text: string }> = [];
		for (const item of data.body || []) {
			const text = (item.content || '').replace(/\s+/g, ' ').trim();
			const from = item.from || 0;
			if (text) out.push({ startMs: Math.round(from * 1000), text });
		}
		return out;
	} catch {
		return [];
	}
}

/**
 * 抓取 B 站视频并生成剪藏内容：iframe 嵌入播放器 + 时间戳字幕段落（可选微软机翻对照）。
 * 无字幕（未配置 SESSDATA 或视频本身没有）时降级为嵌入播放器 + UP主简介。
 */
export async function extractBilibiliArticle(
	url: string,
	settings: WebClippersSettings,
	onProgress?: (message: string) => void
): Promise<BilibiliExtractResult> {
	onProgress?.('正在解析B站视频...');
	const id = await resolveVideoId(url);
	if (!id) {
		throw new Error('无法从链接中识别B站视频 ID，请粘贴视频页地址（bilibili.com 或 b23.tv 短链均可）');
	}

	const info = await fetchViewInfo(id);
	const title = ((info.title as string) || 'B站视频').trim();
	const owner = ((info.owner as Record<string, unknown> | undefined)?.name as string) || '';
	const desc = ((info.desc as string) || '').trim();
	const duration = parseInt(String(info.duration ?? '0'), 10) || 0;

	// 分 P：URL ?p=N 对应 pages[N-1] 的 cid（无 pages 或越界则用主 cid）
	const pages = (info.pages as Array<Record<string, unknown>> | undefined) || [];
	const mainCid = parseInt(String(info.cid ?? '0'), 10) || 0;
	const cid =
		id.page > 1 && pages[id.page - 1]?.cid
			? parseInt(String(pages[id.page - 1].cid), 10)
			: mainCid;
	if (!cid) {
		throw new Error('未获取到视频分 P 信息，无法剪藏');
	}

	// 字幕轨道（游客恒为空；带 SESSDATA 可拿 CC 与 AI）
	onProgress?.('正在获取字幕...');
	const sessdata = (settings as { bilibiliSessdata?: string }).bilibiliSessdata || '';
	const tracks = await fetchSubtitleTracks(id, cid, sessdata);
	const track = pickTrack(tracks);

	// 组装
	const canonicalUrl = id.bvid
		? `https://www.bilibili.com/video/${id.bvid}${id.page > 1 ? `?p=${id.page}` : ''}`
		: `https://www.bilibili.com/video/av${id.aid}${id.page > 1 ? `?p=${id.page}` : ''}`;
	const playerSrc = id.bvid
		? `https://player.bilibili.com/player.html?bvid=${id.bvid}&page=${id.page}&high_quality=1&danmaku=0&autoplay=0`
		: `https://player.bilibili.com/player.html?aid=${id.aid}&page=${id.page}&high_quality=1&danmaku=0&autoplay=0`;

	let markdown = '';
	let subtitleNote = '';

	if (track && track.subtitle_url) {
		onProgress?.('正在下载字幕...');
		let subUrl = track.subtitle_url;
		if (subUrl.startsWith('//')) subUrl = `https:${subUrl}`;
		const subResp = await requestUrl({
			url: subUrl,
			method: 'GET',
			headers: biliHeaders(sessdata),
			throw: false,
		});
		if (subResp.status !== 200) {
			throw new Error(`字幕下载失败（HTTP ${subResp.status}），请稍后重试`);
		}
		const cues = parseSubtitleJson(subResp.text);
		if (cues.length === 0) {
			throw new Error('字幕内容解析为空，该视频的字幕可能不支持导出');
		}

		// 语义分段（与 YouTube 同一套 groupTranscript）
		const groups = groupTranscript(cues);
		if (groups.length === 0) {
			throw new Error('字幕内容解析为空，该视频的字幕可能不支持导出');
		}

		// 翻译：开关开启且字幕语言与目标语言不同族时启用（与 YouTube 一致）
		let translations: string[] | null = null;
		const target = (settings.youtubeTranslateTarget || 'zh-Hans').trim();
		const targetBase = target.split('-')[0].toLowerCase();
		const trackBase = track.lan.toLowerCase();
		const needTranslate =
			settings.youtubeTranslate === true && !trackBase.startsWith(targetBase);
		if (needTranslate) {
			onProgress?.('正在翻译字幕（微软机翻）...');
			// 送翻前剥离纯符号行（B站 AI 字幕常见 [音乐] 之类的标记与 ♪）
			translations = await translateTexts(
				groups.map((g) => {
					const stripped = g.text.replace(/[♪]/g, '').trim();
					return /[\p{L}\p{N}]/u.test(stripped) ? stripped : '';
				}),
				target
			);
		}

		const isAi = track.ai_type === 1;
		subtitleNote = `${track.lan}${track.lan_doc ? ` · ${track.lan_doc}` : ''}${isAi ? '（AI 自动生成）' : '（CC 字幕）'}`;
		const tsUrl = (sec: number) =>
			`${canonicalUrl}${canonicalUrl.includes('?') ? '&' : '?'}t=${sec}s`;
		markdown =
			`<iframe src="${playerSrc}" width="100%" height="420" frameborder="0" allowfullscreen="true"></iframe>\n\n` +
			`## 字幕（${subtitleNote}）\n\n`;
		for (let i = 0; i < groups.length; i++) {
			const t = fmtTime(groups[i].startMs);
			markdown += `- [${t}](${tsUrl(Math.floor(groups[i].startMs / 1000))}) ${groups[i].text}\n`;
			if (translations) {
				const tr = (translations[i] || '').replace(/\r?\n/g, ' ').trim();
				if (tr) markdown += `  ${tr}\n`;
			}
		}
	} else {
		// 无字幕降级：iframe + 简介 + 原因说明（不中断剪藏）
		const reason = sessdata
			? '该视频没有可用字幕（UP主未上传 CC 且未开启 AI 字幕）'
			: '未配置B站登录凭据，无法获取字幕（B站字幕接口需要登录态）';
		subtitleNote = reason;
		markdown =
			`<iframe src="${playerSrc}" width="100%" height="420" frameborder="0" allowfullscreen="true"></iframe>\n\n` +
			`> ${reason}。以下为 UP主简介：\n\n`;
		if (desc) {
			for (const line of desc.split(/\r?\n/)) {
				markdown += `> ${line}\n`;
			}
		}
	}

	const textContent = desc || title;
	const excerpt = `${owner ? owner + ' · ' : ''}${
		duration > 0 ? fmtDuration(duration) + ' · ' : ''
	}${desc ? desc.slice(0, 150) : subtitleNote}`;

	return {
		article: {
			title,
			content: markdown,
			textContent,
			excerpt,
			byline: owner,
			length: textContent.length,
		},
		images: [],
		canonicalUrl,
		markdown,
	};
}
