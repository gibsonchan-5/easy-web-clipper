/**
 * Easy Web Clipper - YouTube 视频剪藏支持
 *
 * 机制说明（2026-09-21 实测）：
 * - 字幕链路：InnerTube player API（ANDROID 客户端，一次请求）返回 videoDetails
 *   （标题/频道/时长）与 captionTracks（手动字幕 + ASR 自动字幕）。
 *   网页 HTML 里抓到的 timedtext 地址直接请求会返回空，必须用 InnerTube 响应里的新鲜地址。
 * - Android 客户端的 timedtext 忽略 fmt=json3，返回 format 3 XML：
 *   `<p t="起始ms" d="时长ms">文本</p>`（部分轨道为 <s> 词级子标签，两种都兼容）。
 * - 笔记内容为成品 Markdown（嵌入播放器 + 时间戳字幕列表），由 clipper.ts 直接采用，
 *   跳过 Readability 清洗与 Turndown——嵌入语法 ![…](url) 不能经过 Turndown（会被转义破坏）。
 * - 翻译：微软 Edge 免费翻译端点（无需密钥）。旧 auth 接口 2026-08 已下线，
 *   现行路径 POST /translate/translatetext?isMultiline=false&to=<lang>，正文为字符串数组，
 *   国内可直连。翻译失败不中断剪藏，降级为仅原文字幕。
 *
 * 网络前提：YouTube 域名需系统代理可用（requestUrl 走系统代理）；翻译端点直连即可。
 */

import { requestUrl } from 'obsidian';
import { WebClippersSettings } from './settings';

const YT_UA =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
/** Edge 端点要求浏览器形态的 User-Agent */
const EDGE_UA =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0';

/** InnerTube ANDROID 客户端参数（实测可稳定返回 captionTracks） */
const INNERTUBE_KEY = 'AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w';
const INNERTUBE_CLIENT_VERSION = '20.10.38';
const INNERTUBE_CLIENT = {
	clientName: 'ANDROID',
	clientVersion: INNERTUBE_CLIENT_VERSION,
	androidSdkVersion: 30,
	hl: 'en',
	gl: 'US',
};
/** InnerTube 必须配 Android 官方 App UA：浏览器 UA 会被判为不可访问 */
const INNERTUBE_UA = `com.google.android.youtube/${INNERTUBE_CLIENT_VERSION} (Linux; U; Android 14)`;

/** 单次翻译请求的最大条数（远端单请求总量上限约 5 万字符，按条数分批足够保守） */
const TRANSLATE_BATCH = 40;

export function isYoutubeUrl(url: string): boolean {
	try {
		const host = new URL(url).hostname.toLowerCase();
		return (
			host === 'youtube.com' ||
			host.endsWith('.youtube.com') ||
			host === 'youtu.be' ||
			host.endsWith('.youtu.be') ||
			host === 'youtube-nocookie.com' ||
			host.endsWith('.youtube-nocookie.com')
		);
	} catch {
		return false;
	}
}

/** 从各种形态的 YouTube 链接中提取视频 ID（watch / youtu.be / shorts / live / embed / v） */
export function extractYoutubeVideoId(url: string): string | null {
	try {
		const u = new URL(url);
		if (u.hostname.toLowerCase().endsWith('youtu.be')) {
			const id = u.pathname.split('/')[1];
			return id || null;
		}
		const v = u.searchParams.get('v');
		if (v) return v;
		const m = u.pathname.match(/^\/(?:shorts|live|embed|v)\/([^/?#]+)/);
		return m ? m[1] : null;
	} catch {
		return null;
	}
}

interface CaptionTrack {
	baseUrl: string;
	languageCode: string;
	kind?: string; // 'asr' = 自动生成
	name?: string;
}

/** 提取结果：与 extractXhsArticle 同形；markdown 为成品笔记正文（clipper.ts 直接采用） */
export interface YoutubeExtractResult {
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

/** 毫秒 → mm:ss / h:mm:ss（时间戳跳转链接用秒） */
export function fmtTime(ms: number): string {
	const total = Math.floor(ms / 1000);
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	const pad = (n: number) => String(n).padStart(2, '0');
	return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** 解码 XML 实体（timedtext 文本里的 &amp; &#39; 等） */
function decodeXmlEntities(s: string): string {
	return s
		.replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
		.replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&amp;/g, '&');
}

/** 解析 timedtext XML → { 起始ms, 文本 }[]（兼容 <p> 直文本与 <s> 词级子标签两种形态） */
function parseTimedtext(xml: string): Array<{ startMs: number; text: string }> {
	const out: Array<{ startMs: number; text: string }> = [];
	for (const m of xml.matchAll(/<p\s+[^>]*?t="(\d+)"[^>]*>([\s\S]*?)<\/p>/g)) {
		let inner = m[2].replace(/<\/?s[^>]*>/g, '');
		inner = decodeXmlEntities(inner).replace(/<[^>]+>/g, '');
		// 字幕文本自带裸换行（一行字幕折两行），进 Markdown 列表会断行，压成单空格
		inner = inner.replace(/\s+/g, ' ').trim();
		if (inner) out.push({ startMs: parseInt(m[1], 10), text: inner });
	}
	return out;
}

// ---------- 字幕语义分段（移植自官方 Web Clipper 的 defuddle 库 groupBySentence 逻辑） ----------

/** 句末标点（拉丁 + CJK，允许收尾引号/括号） */
const SENTENCE_END = /[.!?。！？]["'’”)」』）]*\s*$/;
/** 句中句边界：拉丁「句点+空白+大写开头」或 CJK「句末标点+任意 CJK 字」（无需空格） */
const MID_TEXT_SENTENCE_BOUNDARY = new RegExp(
	'^(.*[.!?]["\'\u2019\u201D)]*)\\s+([A-Z].*)$' +
		'|^(.*[。！？][」』）]*)([\\u3040-\\u309F\\u30A0-\\u30FF\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uAC00-\\uD7AF\\uF900-\\uFAFF].*)$'
);
/** YouTube 常见 10-15s 稀疏字幕窗口仍属同句，只有超大间隔才视为分段点 */
const GROUP_GAP_SECONDS = 20;
/** 无标点 ASR 字幕的分组时长上限：超过后在最佳自然断点切开 */
const MAX_GROUP_SECONDS = 30;
/** 说话人标记（自动字幕的换人记号），视为分段点并剥离 */
const SPEAKER_MARKER = /^(>>\s*|-\s+)/;

/**
 * 把逐条字幕聚合成语义连贯的段落（参考 Obsidian Web Clipper / defuddle 官方实现）：
 * 累积片段直到句末标点；仅超大时间间隔强断；无标点时按时长上限在自然断点切开。
 */
export function groupTranscript(
	cues: Array<{ startMs: number; text: string }>
): Array<{ startMs: number; text: string }> {
	const segments = cues.map((c) => ({ start: c.startMs / 1000, text: c.text }));
	const groups: Array<{ startMs: number; text: string }> = [];
	const pending: Array<{ start: number; text: string }> = [];

	const pushGroup = (segs: Array<{ start: number; text: string }>) => {
		const text = segs.map((s) => s.text).join(' ').trim();
		if (text) groups.push({ startMs: Math.round(segs[0].start * 1000), text });
	};
	const flushAll = () => {
		if (pending.length > 0) pushGroup(pending);
		pending.length = 0;
	};
	const flushUpTo = (idx: number) => {
		if (idx > 0) pushGroup(pending.splice(0, idx));
	};

	for (const raw of segments) {
		// 说话人标记：先断再剥，标记本身不进正文
		const isSpeakerTurn = SPEAKER_MARKER.test(raw.text);
		const seg = { start: raw.start, text: raw.text.replace(SPEAKER_MARKER, '').trim() };
		if (!seg.text) continue;

		if (isSpeakerTurn) flushAll();
		else if (
			pending.length > 0 &&
			seg.start - pending[pending.length - 1].start > GROUP_GAP_SECONDS
		) {
			flushAll();
		}

		pending.push(seg);

		if (SENTENCE_END.test(seg.text)) {
			flushAll();
			continue;
		}

		// 无标点的 ASR 字幕：组时长超限后找自然断点（优先句中句边界，可把片段一分为二）
		if (seg.start - pending[0].start >= MAX_GROUP_SECONDS) {
			const breakIdx = findNaturalBreak(pending);
			if (breakIdx > 0 && breakIdx < pending.length) {
				flushUpTo(breakIdx);
			} else {
				flushAll();
			}
		}
	}
	flushAll();
	return groups;
}

/**
 * 在片段列表中找最佳断点（返回应在其前断开的下标，0 表示找不到）。
 * 优先级 1：靠近尾部含「句中句边界」的片段——把它从边界处一分为二；
 * 优先级 2：最大时间间隔（自然停顿）。
 */
function findNaturalBreak(segments: Array<{ start: number; text: string }>): number {
	if (segments.length <= 1) return -1;
	const minStart = segments[0].start + MAX_GROUP_SECONDS / 2;

	for (let i = segments.length - 1; i >= 0; i--) {
		if (segments[i].start < minStart) break;
		const match = segments[i].text.match(MID_TEXT_SENTENCE_BOUNDARY);
		if (match) {
			const before = match[1] ?? match[3];
			const after = match[2] ?? match[4];
			const start = segments[i].start;
			segments.splice(
				i,
				1,
				{ start, text: before },
				{ start, text: after }
			);
			return i + 1;
		}
	}

	let bestIdx = -1;
	let bestGap = 0;
	for (let i = 1; i < segments.length; i++) {
		if (segments[i].start < minStart) continue;
		const gap = segments[i].start - segments[i - 1].start;
		if (gap >= bestGap) {
			bestGap = gap;
			bestIdx = i;
		}
	}
	return bestIdx;
}

/** 秒 → 「x 分 y 秒」形式的时长描述（front matter 摘要用） */
export function fmtDuration(seconds: number): string {
	const m = Math.floor(seconds / 60);
	const s = seconds % 60;
	return m > 0 ? `${m}分${s}秒` : `${s}秒`;
}

/** 调用 InnerTube player API，返回 player 响应 JSON */
async function fetchPlayerResponse(videoId: string): Promise<Record<string, unknown>> {
	const resp = await requestUrl({
		url: `https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_KEY}`,
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'User-Agent': INNERTUBE_UA,
		},
		body: JSON.stringify({
			context: { client: INNERTUBE_CLIENT },
			videoId,
		}),
		throw: false,
	});
	if (resp.status !== 200) {
		throw new Error(
			`YouTube 接口返回 HTTP ${resp.status}。剪藏 YouTube 需要系统代理可用（Clash 开启系统代理），请检查网络后重试`
		);
	}
	return resp.json as Record<string, unknown>;
}

/** 从 captionTracks 里选轨道：手动字幕优先（zh > en > 首个），否则 ASR 自动字幕 */
function pickTrack(tracks: CaptionTrack[]): CaptionTrack | null {
	if (tracks.length === 0) return null;
	const preferred = (arr: CaptionTrack[]) =>
		arr.find((t) => t.languageCode.toLowerCase().startsWith('zh')) ||
		arr.find((t) => t.languageCode.toLowerCase().startsWith('en')) ||
		arr[0];
	const manual = tracks.filter((t) => t.kind !== 'asr');
	const asr = tracks.filter((t) => t.kind === 'asr');
	return preferred(manual) || preferred(asr) || null;
}

/** 批量调用微软 Edge 免费翻译端点（无密钥，国内直连可用）。失败时返回 null（降级为仅原文） */
export async function translateTexts(texts: string[], target: string): Promise<string[] | null> {
	const results: string[] = [];
	for (let i = 0; i < texts.length; i += TRANSLATE_BATCH) {
		const batch = texts.slice(i, i + TRANSLATE_BATCH);
		try {
			const resp = await requestUrl({
				url: `https://edge.microsoft.com/translate/translatetext?isMultiline=false&to=${encodeURIComponent(target)}`,
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'User-Agent': EDGE_UA,
				},
				body: JSON.stringify(batch),
				throw: false,
			});
			if (resp.status !== 200) return null;
			const data = resp.json as Array<{ translations?: Array<{ text?: string }> }>;
			for (const item of data) {
				results.push(item.translations?.[0]?.text ?? '');
			}
		} catch {
			return null;
		}
	}
	return results.length === texts.length ? results : null;
}

/**
 * 抓取 YouTube 视频并生成剪藏内容：嵌入播放器 + 时间戳字幕（可选中英对照翻译）。
 * 返回的 markdown 为成品正文，clipper.ts 会跳过清洗与 Turndown 直接采用。
 */
export async function extractYoutubeArticle(
	url: string,
	settings: WebClippersSettings,
	onProgress?: (message: string) => void
): Promise<YoutubeExtractResult> {
	const videoId = extractYoutubeVideoId(url);
	if (!videoId || !/^[\w-]{6,20}$/.test(videoId)) {
		throw new Error('无法从链接中识别 YouTube 视频 ID，请粘贴视频页地址');
	}

	onProgress?.('正在获取视频信息...');
	const player = await fetchPlayerResponse(videoId);

	const playability = player.playabilityStatus as Record<string, unknown> | undefined;
	if (playability?.status !== 'OK') {
		const reason = (playability?.reason as string) || '视频不可访问';
		throw new Error(`YouTube 视频无法访问：${reason}`);
	}

	const details = player.videoDetails as Record<string, unknown> | undefined;
	const title = ((details?.title as string) || `YouTube 视频 ${videoId}`).trim();
	const author = ((details?.author as string) || '').trim();
	const lengthSeconds = parseInt((details?.lengthSeconds as string) || '0', 10) || 0;

	const captions = (
		(
			player.captions as Record<string, unknown> | undefined
		)?.playerCaptionsTracklistRenderer as Record<string, unknown> | undefined
	)?.captionTracks as CaptionTrack[] | undefined;
	if (!captions || captions.length === 0) {
		throw new Error('该视频没有可用字幕（未上传字幕也未开启自动识别），无法剪藏');
	}

	const track = pickTrack(captions);
	if (!track || !track.baseUrl) {
		throw new Error('未找到可用的字幕轨道');
	}

	onProgress?.('正在下载字幕...');
	const trackResp = await requestUrl({
		url: track.baseUrl,
		method: 'GET',
		headers: { 'User-Agent': YT_UA },
		throw: false,
	});
	if (trackResp.status !== 200) {
		throw new Error(`字幕下载失败（HTTP ${trackResp.status}），请稍后重试`);
	}
	const lines = parseTimedtext(trackResp.text);
	if (lines.length === 0) {
		throw new Error('字幕内容解析为空，该视频的字幕可能不支持导出');
	}

	// 语义分段：逐条字幕聚合为连贯段落（参考官方 Web Clipper 的 defuddle 切分逻辑）
	const groups = groupTranscript(lines);
	if (groups.length === 0) {
		throw new Error('字幕内容解析为空，该视频的字幕可能不支持导出');
	}

	// 翻译：开关开启且字幕语言与目标语言不同族时启用；失败降级为仅原文。
	// 以「段落」为翻译单位：上下文更完整，请求数也更少
	let translations: string[] | null = null;
	const target = (settings.youtubeTranslateTarget || 'zh-Hans').trim();
	const targetBase = target.split('-')[0].toLowerCase();
	const trackBase = track.languageCode.toLowerCase();
	const needTranslate =
		settings.youtubeTranslate === true && !trackBase.startsWith(targetBase);
	if (needTranslate) {
		onProgress?.('正在翻译字幕（微软机翻）...');
		// 送翻前剥离 ♪ 音符（机翻会把 ♪ 混进译文）；剥离后不含任何字母数字的纯符号行
		//（如 [♪♪♪]）不送翻，译文留空则不渲染对照行
		translations = await translateTexts(
			groups.map((g) => {
				const stripped = g.text.replace(/[♪]/g, '').trim();
				return /[\p{L}\p{N}]/u.test(stripped) ? stripped : '';
			}),
			target
		);
	}

	// 组装成品 Markdown：嵌入播放器 + 时间戳段落列表
	const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
	const mdParts: string[] = [`![${title.replace(/\]\[/g, ' ')}](${watchUrl})`];
	mdParts.push('');
	const langNote = track.kind === 'asr' ? '自动生成' : '手动上传';
	mdParts.push(`## 字幕（${track.languageCode} · ${langNote}）`);
	mdParts.push('');
	for (let i = 0; i < groups.length; i++) {
		const t = fmtTime(groups[i].startMs);
		const sec = Math.floor(groups[i].startMs / 1000);
		mdParts.push(`- [${t}](${watchUrl}&t=${sec}s) ${groups[i].text}`);
		if (translations) {
			const tr = (translations[i] || '').replace(/\r?\n/g, ' ').trim();
			if (tr) mdParts.push(`  ${tr}`);
		}
	}
	const markdown = mdParts.join('\n') + '\n';

	const textContent = groups.map((g) => g.text).join('\n');

	return {
		article: {
			title,
			content: markdown,
			textContent,
			excerpt: `${author ? author + ' · ' : ''}${
				lengthSeconds > 0 ? fmtDuration(lengthSeconds) + ' · ' : ''
			}${textContent.slice(0, 150)}`,
			byline: author,
			length: textContent.length,
		},
		images: [],
		canonicalUrl: watchUrl,
		markdown,
	};
}
