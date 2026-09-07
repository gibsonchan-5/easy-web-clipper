import { App, Plugin, PluginSettingTab, Setting, Notice, Modal } from 'obsidian';
import {
	WebClippersSettings, DEFAULT_SETTINGS,
	MODAL_MIN_WIDTH, MODAL_DEFAULT_WIDTH, MODAL_VIEWPORT_MARGIN, MODAL_RECT_VERSION,
} from './settings';
import { clipWebPage, extractUrl } from './clipper';

export default class WebClippersPlugin extends Plugin {
	settings: WebClippersSettings;

	async onload() {
		await this.loadSettings();

		this.addRibbonIcon('scissors', '网页剪藏', () => {
			new WebClipperModal(this.app, this).open();
		});

		this.addCommand({
			id: 'clip-web-page',
			name: '剪藏网页',
			callback: () => {
				new WebClipperModal(this.app, this).open();
			},
		});

		this.addCommand({
			id: 'clip-clipboard-url',
			name: '剪藏剪贴板中的链接',
			callback: async () => {
				try {
					const text = await navigator.clipboard.readText();
					const url = extractUrl(text);
					if (!url) {
						new Notice('剪贴板中没有有效的 URL');
						return;
					}
					await this.performClip(url);
				} catch (e) {
					new Notice('读取剪贴板失败：' + (e as Error).message);
				}
			},
		});

		this.addSettingTab(new WebClippersSettingTab(this.app, this));
	}

	async performClip(url: string) {
		const notice = new Notice('正在剪藏...', 0);
		try {
			const file = await clipWebPage(url, this.vault, this.settings, (msg) => {
				notice.setMessage(msg);
			});
			notice.hide();
			new Notice('已剪藏：' + file.basename);
			if (this.settings.openAfterClip) {
				this.app.workspace.openLinkText(file.path, '', true);
			}
		} catch (e) {
			notice.hide();
			new Notice('剪藏失败：' + (e as Error).message);
		}
	}

	async loadSettings() {
		const saved = await this.loadData() || {};
		// 迁移：旧版本 savePath 为根目录或旧默认值时，升级到新默认值
		const oldPaths = ['', '/', 'Easy Web Clipper'];
		if (!saved.savePath || oldPaths.includes(saved.savePath)) {
			saved.savePath = DEFAULT_SETTINGS.savePath;
		}
		this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);

		// 布局规则变更（改为只记忆宽度、默认宽度收窄）后作废旧记录
		if (this.settings.modalRectVersion !== MODAL_RECT_VERSION) {
			this.settings.modalRect = null;
			this.settings.modalRectVersion = MODAL_RECT_VERSION;
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

/**
 * 剪藏窗口：可拖拽（顶部标题栏）、可拖动左右边缘调整宽度（高度随内容自适应），
 * 位置与宽度会记住，下次打开时恢复。
 */
class WebClipperModal extends Modal {
	plugin: WebClippersPlugin;
	settings: WebClippersSettings;
	url: string = '';
	isProcessing: boolean = false;

	private handleWindowResize = () => this.clampIntoViewport();
	private handleGeometries: Array<{ handle: HTMLElement; dir: 'w' | 'e' }> = [];

	constructor(app: App, plugin: WebClippersPlugin) {
		super(app);
		this.plugin = plugin;
		this.settings = plugin.settings;
	}

	onOpen() {
		const { contentEl, modalEl, containerEl, titleEl } = this;
		contentEl.empty();

		containerEl.addClass('ewc-modal-container');
		modalEl.addClass('ewc-modal');
		// 标题栏 = 拖拽把手
		titleEl.addClass('ewc-modal-header');
		titleEl.setText('网页剪藏');
		contentEl.addClass('ewc-modal-content');

		// 窗口的静态样式全部由 styles.css 的 ewc-* 类提供（遵循官方「不要硬编码样式」要求）
		// JS 只负责动态值：坐标、宽度、高度上限

		this.buildContent(contentEl);
		this.createResizeHandles(modalEl);

		// 兜底：若 styles.css 未生效（例如手动部署时漏掉该文件），补上布局必需样式，
		// 避免窗口退化成「固定居中、不能拖拽也不能缩放」。只设几何，不含任何颜色值。
		this.ensureLayoutStyles();

		// 恢复上次的窗口位置与尺寸（无记录则居中 + 内容自然高度）
		this.applyInitialLayout();

		this.setupDrag();
		window.addEventListener('resize', this.handleWindowResize);
	}

	onClose() {
		window.removeEventListener('resize', this.handleWindowResize);
		this.contentEl.empty();
	}

	// ---------- 内容 ----------

	private buildContent(contentEl: HTMLElement) {
		// URL 输入框（样式见 styles.css 的 .ewc-input）
		const urlInput = contentEl.createEl('input', {
			type: 'text',
			cls: 'ewc-input',
			attr: { placeholder: '粘贴网页链接' },
		});

		navigator.clipboard.readText().then(clipText => {
			const url = extractUrl(clipText);
			if (url) { urlInput.value = url; this.url = url; }
		}).catch(() => { });

		urlInput.addEventListener('input', (e: Event) => {
			this.url = (e.target as HTMLInputElement).value;
		});
		urlInput.addEventListener('keydown', (e: KeyboardEvent) => {
			if (e.key === 'Enter' && !this.isProcessing) this.doClip();
		});

		// 保存路径（只读文本 + 提示）
		contentEl.createDiv({ cls: 'ewc-label', text: '保存至' });
		contentEl.createDiv({ cls: 'ewc-path', text: this.settings.savePath });
		contentEl.createDiv({ cls: 'ewc-hint', text: '可在设置中修改默认保存路径' });

		// 底部按钮（窄窗口时自动换行，不会被截断）
		// 主按钮复用 Obsidian 内置的 .mod-cta 样式，避免硬编码颜色
		const actions = contentEl.createDiv({ cls: 'ewc-actions' });

		const cancelBtn = actions.createEl('button', { cls: 'ewc-btn', text: '取消' });
		cancelBtn.addEventListener('click', () => this.close());

		const clipBtn = actions.createEl('button', { cls: 'ewc-btn mod-cta', text: '剪藏' });
		clipBtn.addEventListener('click', () => this.doClip());
	}

	// ---------- 布局：位置 / 宽度 ----------

	private applyInitialLayout() {
		const modal = this.modalEl;
		const saved = this.plugin.settings.modalRect;

		// 高度不可调整，始终由内容决定；只记忆位置与宽度
		const width = saved && saved.width > 0 ? saved.width : MODAL_DEFAULT_WIDTH;
		modal.style.width = this.clampWidth(width) + 'px';
		this.applyMaxHeight();

		if (saved && (saved.x !== 0 || saved.y !== 0)) {
			this.setPosition(saved.x, saved.y);
			return;
		}

		// 首次打开：按内容算出自然高度，再居中
		this.setPosition(
			(window.innerWidth - modal.offsetWidth) / 2,
			(window.innerHeight - modal.offsetHeight) / 2.4
		);
	}

	private clampWidth(width: number): number {
		return Math.round(Math.max(MODAL_MIN_WIDTH, Math.min(width, window.innerWidth)));
	}

	/** 高度上限：内容再高也不超出屏幕，超出部分在内容区滚动 */
	private applyMaxHeight() {
		const max = Math.max(120, window.innerHeight - MODAL_VIEWPORT_MARGIN * 2);
		this.modalEl.style.setProperty('max-height', max + 'px', 'important');
	}

	/** 把窗口限制在可视区域内 */
	private clampPosition(x: number, y: number): { x: number; y: number } {
		const winW = window.innerWidth;
		const winH = window.innerHeight;
		const w = this.modalEl.offsetWidth;
		const h = this.modalEl.offsetHeight;
		const left = Math.min(Math.max(0, x), Math.max(0, winW - w));
		const top = Math.min(Math.max(0, y), Math.max(0, winH - h));
		return { x: Math.round(left), y: Math.round(top) };
	}

	private setPosition(x: number, y: number) {
		const pos = this.clampPosition(x, y);
		this.modalEl.style.left = pos.x + 'px';
		this.modalEl.style.top = pos.y + 'px';
	}

	/** 浏览器窗口尺寸变化时，保证弹窗仍完整可见 */
	private clampIntoViewport() {
		const r = this.modalEl.getBoundingClientRect();
		if (!r.width || !r.height) return;
		this.applyMaxHeight();
		this.setPosition(r.left, r.top);
	}

	private saveLayout() {
		const r = this.modalEl.getBoundingClientRect();
		if (!r.width || !r.height) return;
		this.plugin.settings.modalRect = {
			x: Math.round(r.left),
			y: Math.round(r.top),
			width: Math.round(r.width),
			height: Math.round(r.height),
		};
		void this.plugin.saveSettings();
	}

	// ---------- 拖拽 ----------

	private setupDrag() {
		const header = this.titleEl;
		const doc = this.containerEl.ownerDocument;

		header.addEventListener('pointerdown', (e: PointerEvent) => {
			if (e.pointerType === 'mouse' && e.button !== 0) return;
			const target = e.target as HTMLElement;
			// 关闭按钮 / 输入控件上不触发拖拽
			if (target.closest('.modal-close-button, input, textarea, select, button, a')) return;

			const rect = this.modalEl.getBoundingClientRect();
			const offsetX = e.clientX - rect.left;
			const offsetY = e.clientY - rect.top;

			const body = doc.body;
			body.addClass('ewc-dragging');

			const onMove = (ev: PointerEvent) => {
				// 拖拽只改变坐标，宽度保持不变
				this.setPosition(ev.clientX - offsetX, ev.clientY - offsetY);
			};

			const onUp = () => {
				doc.removeEventListener('pointermove', onMove, true);
				doc.removeEventListener('pointerup', onUp, true);
				doc.removeEventListener('pointercancel', onUp, true);
				body.removeClass('ewc-dragging');
				this.saveLayout();
			};

			doc.addEventListener('pointermove', onMove, true);
			doc.addEventListener('pointerup', onUp, true);
			doc.addEventListener('pointercancel', onUp, true);
			e.preventDefault();
		});
	}

	// ---------- 缩放 ----------

	private createResizeHandles(modalEl: HTMLElement) {
		const doc = this.containerEl.ownerDocument;
		this.handleGeometries = [];

		// 只保留左右两条边：宽度可调，高度由内容自适应
		// 手柄的几何与光标由 styles.css 的 .ewc-resize-* 提供
		for (const dir of ['w', 'e'] as const) {
			const handle = modalEl.createDiv({ cls: ['ewc-resize-handle', `ewc-resize-${dir}`] });
			handle.addEventListener('pointerdown', (e: PointerEvent) => this.startResize(e, doc, dir));
			this.handleGeometries.push({ handle, dir });
		}
	}

	/**
	 * 兜底：仅当 styles.css 未生效时补写布局必需样式（不含任何颜色值）。
	 * 正常环境下 styles.css 一定会加载，这里不会执行任何写入，
	 * 因此既满足官方「不要硬编码样式」要求，也不会出现窗口无法拖拽/缩放的退化。
	 */
	private ensureLayoutStyles() {
		const computed = this.modalEl.ownerDocument.defaultView?.getComputedStyle(this.modalEl);
		if (computed && computed.position === 'fixed') return; // 样式表已生效，无需兜底

		this.modalEl.style.cssText +=
			';position:fixed;margin:0;max-width:none;display:flex;flex-direction:column;' +
			'box-sizing:border-box;overflow:hidden;';
		this.contentEl.style.cssText += ';flex:1 1 auto;overflow:auto;';
		for (const { handle, dir } of this.handleGeometries) {
			handle.style.cssText +=
				`;position:absolute;top:0;bottom:0;${dir === 'w' ? 'left' : 'right'}:0;` +
				'width:10px;cursor:ew-resize;touch-action:none;';
		}
	}

	private startResize(e: PointerEvent, doc: Document, dir: 'w' | 'e') {
		if (e.pointerType === 'mouse' && e.button !== 0) return;
		e.preventDefault();
		e.stopPropagation();

		const start = this.modalEl.getBoundingClientRect();
		const originX = e.clientX;
		const body = doc.body;
		// 注意：Obsidian 的 addClass 底层是 classList.add()，一个参数里不能带空格
		body.addClass('ewc-resizing', `ewc-resizing-${dir}`);

		const onMove = (ev: PointerEvent) => {
			const dx = ev.clientX - originX;
			let left = start.left;
			let width = dir === 'e' ? start.width + dx : start.width - dx;
			if (dir === 'w') left = start.left + dx;

			// 最小宽度：贴住最小边时位置跟着吸附，避免鼠标与窗口脱节
			if (width < MODAL_MIN_WIDTH) {
				if (dir === 'w') left = start.left + start.width - MODAL_MIN_WIDTH;
				width = MODAL_MIN_WIDTH;
			}

			this.modalEl.style.width = this.clampWidth(width) + 'px';
			// 高度随内容重排，重新校正纵向位置，避免底部被顶出屏幕
			this.setPosition(left, this.modalEl.getBoundingClientRect().top);
		};

		const onUp = () => {
			doc.removeEventListener('pointermove', onMove, true);
			doc.removeEventListener('pointerup', onUp, true);
			doc.removeEventListener('pointercancel', onUp, true);
			body.removeClass('ewc-resizing', `ewc-resizing-${dir}`);
			this.saveLayout();
		};

		doc.addEventListener('pointermove', onMove, true);
		doc.addEventListener('pointerup', onUp, true);
		doc.addEventListener('pointercancel', onUp, true);
	}

	// ---------- 剪藏 ----------

	async doClip() {
		if (this.isProcessing) return;
		const url = this.url.trim();
		if (!url) { new Notice('请输入网页链接'); return; }
		if (!url.startsWith('http://') && !url.startsWith('https://')) { new Notice('请输入有效的 URL'); return; }

		this.isProcessing = true;
		try {
			const file = await clipWebPage(url, this.app.vault, this.settings, () => { });
			this.close();
			new Notice('已剪藏：' + file.basename);
			if (this.settings.openAfterClip) {
				this.app.workspace.openLinkText(file.path, '', true);
			}
		} catch (e) {
			new Notice('剪藏失败：' + (e as Error).message);
			this.isProcessing = false;
		}
	}
}

class WebClippersSettingTab extends PluginSettingTab {
	plugin: WebClippersPlugin;

	constructor(app: App, plugin: WebClippersPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('h2', { text: 'Easy Web Clipper 设置' });

		// 获取所有文件夹
		const folderSet = new Set<string>();
		this.app.vault.getAllLoadedFiles().forEach((f: any) => {
			if (f.parent && typeof f.parent.path === 'string') {
				folderSet.add(f.parent.path);
			}
		});
		folderSet.add(''); // 根目录
		const folders = Array.from(folderSet).sort((a, b) => {
			if (a === '') return -1;
			if (b === '') return 1;
			return a.localeCompare(b);
		});

		const saveSetting = new Setting(containerEl)
			.setName('默认保存路径')
			.setDesc('剪藏笔记保存的默认文件夹路径');

		// 文本输入框
		saveSetting.addText((text) =>
			text
				.setPlaceholder('EasyWebClipper')
				.setValue(this.plugin.settings.savePath)
				.onChange(async (value) => {
					this.plugin.settings.savePath = value || DEFAULT_SETTINGS.savePath;
					await this.plugin.saveSettings();
				})
		);

		// 文件夹下拉选择器
		saveSetting.addDropdown((dropdown) => {
			dropdown.addOption('', '/（根目录）');
			folders.filter(f => f !== '').forEach(f => {
				dropdown.addOption(f, f);
			});
			dropdown.setValue(this.plugin.settings.savePath);
			dropdown.onChange(async (value) => {
				this.plugin.settings.savePath = value || DEFAULT_SETTINGS.savePath;
				await this.plugin.saveSettings();
			});
		});

		new Setting(containerEl)
			.setName('包含 Front Matter')
			.setDesc('是否在笔记开头添加 YAML 元数据')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.includeFrontMatter)
					.onChange(async (value) => {
						this.plugin.settings.includeFrontMatter = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('包含来源链接')
			.setDesc('在 Front Matter 中记录原始网页地址')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.includeSourceUrl)
					.onChange(async (value) => {
						this.plugin.settings.includeSourceUrl = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('包含剪藏日期')
			.setDesc('在 Front Matter 中记录剪藏时间')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.includeClipDate)
					.onChange(async (value) => {
						this.plugin.settings.includeClipDate = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('剪藏后打开笔记')
			.setDesc('剪藏成功后自动打开新创建的笔记')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.openAfterClip)
					.onChange(async (value) => {
						this.plugin.settings.openAfterClip = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('剪藏窗口')
			.setDesc('可拖拽标题栏移动窗口，也可拖动左右边缘调整宽度（高度随内容自适应）。位置与宽度会自动记住，若窗口跑出屏幕可点此恢复。')
			.addButton((button) =>
				button
					.setButtonText('恢复默认布局')
					.onClick(async () => {
						this.plugin.settings.modalRect = null;
						await this.plugin.saveSettings();
						new Notice('已恢复剪藏窗口默认位置与大小');
					})
			);
	}
}
