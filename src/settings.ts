export interface ModalRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface WebClippersSettings {
	savePath: string;
	fileNameTemplate: string;
	includeFrontMatter: boolean;
	includeSourceUrl: boolean;
	includeClipDate: boolean;
	openAfterClip: boolean;
	/** 剪藏窗口上次的位置与宽度（null 表示使用默认居中布局） */
	modalRect: ModalRect | null;
	/** 布局记录的版本号，规则变更时用于作废旧记录 */
	modalRectVersion: number;
	/** YouTube：开启后非目标语言字幕自动附微软机翻对照（默认关） */
	youtubeTranslate: boolean;
	/** YouTube 翻译目标语言（BCP-47，如 zh-Hans） */
	youtubeTranslateTarget: string;
	/** B站登录凭据（可选）：字幕接口需要登录态，留空则只剪嵌入播放器与简介 */
	bilibiliSessdata: string;
}

export const DEFAULT_SETTINGS: WebClippersSettings = {
	savePath: 'EasyWebClipper',
	fileNameTemplate: '{{title}}',
	includeFrontMatter: true,
	includeSourceUrl: true,
	includeClipDate: true,
	openAfterClip: true,
	modalRect: null,
	modalRectVersion: 0,
	youtubeTranslate: false,
	youtubeTranslateTarget: 'zh-Hans',
	bilibiliSessdata: '',
};

/** 布局记录版本：规则变更（如改为只记宽度）时 +1，旧记录自动作废 */
export const MODAL_RECT_VERSION = 2;

/** 窗口最小宽度（缩放时不会小于这个值） */
export const MODAL_MIN_WIDTH = 320;
/** 首次打开时的默认宽度 */
export const MODAL_DEFAULT_WIDTH = 460;
/** 窗口与屏幕上下边缘的安全间距 */
export const MODAL_VIEWPORT_MARGIN = 24;
