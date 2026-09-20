/**
 * Easy Web Clipper - 知乎专用引擎（桌面端）
 *
 * 背景：知乎 zse-ck v4 反爬会拦截一切纯 HTTP 请求（requestUrl 拿到的永远是 403 挑战页）。
 * 2026-09-20 实测矩阵：
 * - Playwright 裁剪 Chromium（headless）：被指纹识破 ❌
 * - 系统 Chrome `--headless=new --dump-dom`（临时 profile）：通过 ✅，但每次冷启动
 *   + zse-ck 挑战固定成本约 5-6s
 * - CDP 控制 + **持久 profile**：挑战 cookie（__zse_ck）跨剪藏保留在 profile 里，
 *   第二次起免挑战，单次剪藏实测 1.1-2.4s ✅
 * - 常驻 Chrome 进程：无额外收益（cookie 在 profile 不在进程），且增加进程管理复杂度 ❌
 *
 * 关键发现（踩坑实录）：
 * 1. Chrome 带 --remote-debugging-port 时 navigator.webdriver=true，被知乎识别签发毒
 *    token（40362「请求存在异常」）；--disable-blink-features=AutomationControlled 可隐藏。
 * 2. 突发连发（预热+连剪，1 分钟内 3+ 次整页加载）必触发 IP 级 40362 限流；间隔 20s
 *    的单次请求稳定通过 —— 所以本引擎内置请求节流，且打开窗口时不做网络预热。
 * 3. 持久 profile + --dump-dom 会挂起（原因未明，三次全超时），不可用；cookie 复用
 *    只能走 CDP 路径。
 *
 * 最终方案：每次剪藏快速拉起一个带调试端口的 Chrome（约 0.4s），CDP 开标签页加载
 * 知乎页面，真实时间轮询正文出现后取 DOM，用完即关。挑战 cookie 由持久 profile 复用。
 * 一次性 --dump-dom 渲染保留为兜底路径。
 */

import type { ChildProcess } from 'child_process';
import { Platform } from 'obsidian';

/**
 * Node 模块懒加载（仅桌面端）。移动端 Obsidian 没有 child_process/fs/os/path，
 * 顶层静态导入会让插件在移动端整包加载失败——manifest 声明 isDesktopOnly:false
 * 时这是社区审核红线。所有调用点都必须位于 Platform.isDesktopApp 守卫之后。
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
function nodeRequire(mod: string): any | null {
	if (!Platform.isDesktopApp) return null;
	try {
		const req = (window as unknown as { require?: (id: string) => unknown }).require;
		return req ? req(mod) : null;
	} catch {
		return null;
	}
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const CHROME_UA =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** 常规渲染等待预算（毫秒）：实测知乎文章在 4s 内已完整渲染（含 zse-ck 挑战） */
const BUDGET_FAST = 4000;
/** 兜底渲染预算（毫秒）：快速档拿不到正文时（慢网络/长文）用大预算重试一次 */
const BUDGET_FALLBACK = 20000;
/** 进程级超时（毫秒） */
const SPAWN_TIMEOUT = 45000;

/** CDP 渲染轮询超时（毫秒） */
const CDP_WAIT_TIMEOUT = 35000;
/** 两次知乎请求之间的最小间隔（毫秒）：防止突发连发触发 IP 限流（40362） */
const REQUEST_INTERVAL_MS = 8000;
/** 持久 profile：挑战 cookie 跨剪藏保留，实现免挑战秒开（懒解析，避免移动端触 Node API） */
function profileDir(): string {
	return nodeRequire('path').join(nodeRequire('os').tmpdir(), 'easy-web-clipper-zhihu-profile');
}

const ZHIHU_MARKER = /Post-RichTextContainer|RichContent-inner|QuestionHeader-title/;

/** dump 结果中是否包含知乎正文标记（专栏 / 回答 / 问题标题任一出现即视为渲染成功） */
function looksLikeArticle(html: string): boolean {
	return (
		html.length > 1000 &&
		ZHIHU_MARKER.test(html)
	);
}

export function isZhihuUrl(url: string): boolean {
	try {
		const u = new URL(url);
		return /(^|\.)zhihu\.com$/i.test(u.hostname);
	} catch {
		return false;
	}
}

/** 按平台枚举本机可能的 Chrome / Edge / Chromium 可执行文件路径 */
function findChromeBinary(): string | null {
	const fs = nodeRequire('fs');
	if (!fs || typeof fs.existsSync !== 'function') return null;
	const candidates: string[] = [];
	if (process.platform === 'darwin') {
		candidates.push(
			'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
			'/Applications/Chromium.app/Contents/MacOS/Chromium',
			'/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
			'/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
			'/Applications/Arc.app/Contents/MacOS/Arc'
		);
	} else if (process.platform === 'win32') {
		const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
		const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
		const local = process.env['LOCALAPPDATA'] || '';
		candidates.push(
			`${pf}\\Google\\Chrome\\Application\\chrome.exe`,
			`${pf86}\\Google\\Chrome\\Application\\chrome.exe`,
			`${local}\\Google\\Chrome\\Application\\chrome.exe`,
			`${pf86}\\Microsoft\\Edge\\Application\\msedge.exe`,
			`${pf}\\Microsoft\\Edge\\Application\\msedge.exe`
		);
	} else {
		candidates.push(
			'/usr/bin/google-chrome',
			'/usr/bin/google-chrome-stable',
			'/usr/bin/chromium',
			'/usr/bin/chromium-browser',
			'/usr/bin/microsoft-edge'
		);
	}
	for (const c of candidates) {
		if (c && fs.existsSync(c)) return c;
	}
	return null;
}

/* ------------------------------------------------------------------ */
/* 极简 CDP 客户端                                                     */
/* ------------------------------------------------------------------ */

class CdpConn {
	private ws: WebSocket;
	private seq = 0;
	private pending = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>();

	constructor(wsUrl: string) {
		this.ws = new WebSocket(wsUrl);
	}

	open(timeoutMs = 8000): Promise<void> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('CDP 连接超时')), timeoutMs);
			this.ws.onopen = () => {
				clearTimeout(timer);
				resolve();
			};
			this.ws.onerror = () => {
				clearTimeout(timer);
				reject(new Error('CDP 连接失败'));
			};
			this.ws.onmessage = (ev: MessageEvent) => {
				try {
					const msg = JSON.parse(String(ev.data)) as {
						id?: number;
						error?: { message?: string };
						result?: unknown;
					};
					if (msg.id && this.pending.has(msg.id)) {
						const p = this.pending.get(msg.id)!;
						this.pending.delete(msg.id);
						if (msg.error) p.rej(new Error(msg.error.message || 'CDP 调用失败'));
						else p.res(msg.result);
					}
				} catch {
					// 忽略无法解析的消息
				}
			};
			this.ws.onclose = () => {
				clearTimeout(timer);
				for (const [, p] of this.pending) p.rej(new Error('CDP 连接已关闭'));
				this.pending.clear();
			};
		});
	}

	send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown> {
		const id = ++this.seq;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { res: resolve, rej: reject });
			this.ws.send(
				JSON.stringify({ id, method, params: params ?? {}, ...(sessionId ? { sessionId } : {}) })
			);
		});
	}

	close(): void {
		try {
			this.ws.close();
		} catch {
			// 已关闭
		}
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/* ------------------------------------------------------------------ */
/* CDP 快速渲染（cookie 复用的秒剪路径）                                */
/* ------------------------------------------------------------------ */

/** 拉起带调试端口的 Chrome，返回进程与浏览器级 WebSocket 地址 */
function spawnDebuggingChrome(
	bin: string
): Promise<{ proc: ChildProcess; wsUrl: string }> {
	return new Promise((resolve, reject) => {
		const args = [
			'--headless=new',
			'--disable-gpu',
			'--no-first-run',
			'--no-default-browser-check',
			'--blink-settings=imagesEnabled=false',
			// 关键：隐藏 navigator.webdriver 自动化标志，否则被知乎识别签发毒 token（40362）
			'--disable-blink-features=AutomationControlled',
			`--user-agent=${CHROME_UA}`,
			`--user-data-dir=${profileDir()}`,
			'--remote-debugging-port=0',
			'about:blank',
		];
		let proc: ChildProcess;
		try {
			const cp = nodeRequire('child_process');
			if (!cp || typeof cp.spawn !== 'function') {
				reject(new Error('当前环境不支持调用本机 Chrome'));
				return;
			}
			proc = cp.spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
		} catch {
			reject(new Error('Chrome 启动失败'));
			return;
		}

		let settled = false;
		const timer = setTimeout(() => {
			if (!settled) {
				settled = true;
				proc.kill();
				reject(new Error('Chrome 启动超时'));
			}
		}, 15000);

		proc.stderr?.on('data', (chunk: Buffer) => {
			const m = chunk.toString().match(/DevTools listening on (ws:\/\/\S+)/);
			if (m && !settled) {
				settled = true;
				clearTimeout(timer);
				resolve({ proc, wsUrl: m[1] });
			}
		});
		proc.on('exit', () => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				reject(new Error('Chrome 进程提前退出'));
			}
		});
	});
}

/** 单飞锁：并发剪藏串行化（同一 profile 目录不允许两个 Chrome 实例） */
let cdpChain: Promise<unknown> = Promise.resolve();
/** 上次知乎请求时间：用于节流防突发限流 */
let lastRequestAt = 0;

async function fetchViaCdp(bin: string, url: string): Promise<string> {
	// 节流：距上次知乎页面加载不足间隔时，静默等到足够间隔（对用户表现为稍等片刻）
	const since = Date.now() - lastRequestAt;
	if (since < REQUEST_INTERVAL_MS && lastRequestAt > 0) {
		await delay(REQUEST_INTERVAL_MS - since);
	}
	lastRequestAt = Date.now();

	const { proc, wsUrl } = await spawnDebuggingChrome(bin);
	try {
		const conn = new CdpConn(wsUrl);
		await conn.open();
		try {
			const created = (await conn.send('Target.createTarget', { url })) as { targetId: string };
			const targetId = created.targetId;
			try {
				const attached = (await conn.send('Target.attachToTarget', {
					targetId,
					flatten: true,
				})) as { sessionId: string };
				const sid = attached.sessionId;

				const deadline = Date.now() + CDP_WAIT_TIMEOUT;
				while (Date.now() < deadline) {
					await delay(300);
					const r = (await conn.send(
						'Runtime.evaluate',
						{
							expression:
								'(() => ({ url: location.href, html: document.documentElement.outerHTML }))()',
							returnByValue: true,
						},
						sid
					)) as { result?: { value?: { url?: string; html?: string } } };
					const v = r?.result?.value;
					const html = v?.html ?? '';
					if (v?.url && v.url.includes('/account/unhuman')) {
						throw new Error('知乎触发了风控拦截，请稍后再试');
					}
					if (html.includes('"code":40362') || html.includes('&quot;code&quot;:40362')) {
						throw new Error('知乎暂时限制了本次访问（触发频率风控），请等几十秒再试');
					}
					if (looksLikeArticle(html)) {
						// 等一拍让正文后资源节点稳定
						await delay(200);
						return html;
					}
				}
				throw new Error('知乎页面加载超时，未等到正文');
			} finally {
				conn.send('Target.closeTarget', { targetId }).catch(() => {
					// 标签页关闭失败不影响结果
				});
			}
		} finally {
			conn.close();
		}
	} finally {
		proc.removeAllListeners('exit');
		proc.kill();
	}
}

/* ------------------------------------------------------------------ */
/* 一次性渲染（兜底路径，微博共用）                                     */
/* ------------------------------------------------------------------ */

/**
 * 通用「本机 Chrome 一次性无头渲染」引擎：先快速档（禁图 + 小预算），正文标记不出现时
 * 用大预算重试一次。微博（游客系统）使用；也作为知乎 CDP 路径的兜底。
 */
export async function renderWithLocalChrome(
	url: string,
	opts: {
		label: string;
		marker: RegExp;
		budgetFast?: number;
		budgetFallback?: number;
		onProgress?: (message: string) => void;
	}
): Promise<string> {
	if (!Platform.isDesktopApp) {
		throw new Error(`${opts.label}仅支持桌面端（需要调用本机 Chrome）`);
	}

	const bin = findChromeBinary();
	if (!bin) {
		throw new Error(`未找到本机 Chrome/Edge/Chromium，${opts.label}需要已安装其中之一`);
	}

	// 禁用图片加载：图片是页面加载的最大耗时项，而剪藏只需要 DOM 里的图片属性
	const baseArgs = [
		'--headless=new',
		'--disable-gpu',
		'--no-first-run',
		'--no-default-browser-check',
		'--blink-settings=imagesEnabled=false',
		`--user-agent=${CHROME_UA}`,
	];

	const runOnce = (budget: number): Promise<string> =>
		new Promise<string>((resolve, reject) => {
			const args = [
				...baseArgs,
				`--virtual-time-budget=${budget}`,
				'--dump-dom',
				url,
			];
		const cp = nodeRequire('child_process');
		if (!cp || typeof cp.execFile !== 'function') {
			reject(new Error('当前环境不支持调用本机 Chrome'));
			return;
		}
		cp.execFile(
			bin,
			args,
			{ timeout: SPAWN_TIMEOUT, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
				(error, stdout) => {
					if (stdout && stdout.length > 1000) {
						resolve(stdout);
						return;
					}
					if (error && (error as { killed?: boolean }).killed) {
						reject(new Error('Chrome 渲染超时，请稍后重试'));
						return;
					}
					reject(new Error(`Chrome 渲染失败（${opts.label}），页面可能触发了风控，请稍后重试`));
				}
			);
		});

	const budgetFast = opts.budgetFast ?? BUDGET_FAST;
	const budgetFallback = opts.budgetFallback ?? BUDGET_FALLBACK;

	opts.onProgress?.(`正在调用本机 Chrome 渲染${opts.label}页面（约需数秒）...`);
	const fast = await runOnce(budgetFast);
	if (fast.length > 1000 && opts.marker.test(fast)) return fast;

	// 快速档没拿到正文（慢网络/风控挑战未完成/超长文），用大预算重试一次
	opts.onProgress?.('页面加载较慢，正在用更长等待重试...');
	const fallback = await runOnce(budgetFallback);
	if (fallback.length > 1000 && opts.marker.test(fallback)) return fallback;

	throw new Error(`${opts.label}页面已加载但未找到正文，请确认链接指向具体内容页`);
}

/* ------------------------------------------------------------------ */
/* 渲染入口                                                            */
/* ------------------------------------------------------------------ */

/**
 * 用本机 Chrome 渲染知乎页面，返回渲染后的完整 HTML。
 * 主路径：CDP + 持久 profile（首剪含挑战约 2-3s，之后免挑战约 1-2s）；
 * 任何环节失败自动降级一次性渲染（原路径，行为不变）。
 */
export async function fetchZhihuRenderedHtml(
	url: string,
	onProgress?: (message: string) => void
): Promise<string> {
	if (!Platform.isDesktopApp) {
		throw new Error('知乎剪藏仅支持桌面端（需要调用本机 Chrome）');
	}
	const bin = findChromeBinary();
	if (!bin) {
		throw new Error('未找到本机 Chrome/Edge/Chromium，知乎剪藏需要已安装其中之一');
	}

	try {
		// 单飞：并发剪藏串行化（profile 目录不能被两个 Chrome 实例同时使用）
		const task = cdpChain.catch(() => {
			// 前一个任务失败不影响后续
		}).then(() => fetchViaCdp(bin, url));
		cdpChain = task.catch(() => {});
		const html = await task;
		if (looksLikeArticle(html)) return html;
		throw new Error('未取到知乎正文');
	} catch (e) {
		// CDP 路径失败 → 降级一次性渲染（旧路径）
		onProgress?.('快速通道不可用，正在用备用方式渲染（较慢）...');
		return renderWithLocalChrome(url, {
			label: '知乎',
			marker: ZHIHU_MARKER,
			onProgress,
		});
	}
}
