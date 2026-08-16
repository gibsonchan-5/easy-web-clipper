import { App, Plugin, PluginSettingTab, Setting, Notice, Modal, Vault } from 'obsidian';
import { WebClippersSettings, DEFAULT_SETTINGS } from './settings';
import { clipWebPage, extractUrl } from './clipper';

export default class WebClippersPlugin extends Plugin {
	settings: WebClippersSettings;

	async onload() {
		await this.loadSettings();

		this.addRibbonIcon('scissors', '网页剪藏', () => {
			new WebClipperModal(this.app, this.settings, this.vault).open();
		});

		this.addCommand({
			id: 'clip-web-page',
			name: '剪藏网页',
			callback: () => {
				new WebClipperModal(this.app, this.settings, this.vault).open();
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
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class WebClipperModal extends Modal {
	settings: WebClippersSettings;
	vault: Vault;
	url: string = '';
	isProcessing: boolean = false;

	constructor(app: App, settings: WebClippersSettings, vault: Vault) {
		super(app);
		this.settings = settings;
		this.vault = vault;
	}

	onOpen() {
		const contentEl = this.contentEl;
		contentEl.empty();
		contentEl.addClass('easy-web-clipper-modal');

		// 设置 modal 尺寸（保证 URL 能完整显示，移动端适配）
		const modalEl = this.modalEl;
		if (modalEl) {
			modalEl.style.width = '560px';
			modalEl.style.maxWidth = '90vw';
			modalEl.style.maxHeight = '85vh';
		}
		contentEl.style.width = '100%';
		contentEl.style.boxSizing = 'border-box';

		// 标题
		const title = document.createElement('div');
		title.textContent = '网页剪藏';
		title.style.cssText = 'font-size:14px;font-weight:400;color:var(--text-normal);margin-bottom:16px;letter-spacing:0.05em;';
		contentEl.appendChild(title);

		// URL 输入框（带边框）
		const urlInput = document.createElement('input');
		urlInput.type = 'text';
		urlInput.placeholder = '粘贴网页链接';
		urlInput.style.cssText = 'display:block;width:100%;box-sizing:border-box;border:1px solid var(--background-modifier-border);border-radius:6px;outline:none;background:var(--background-primary);font-size:14px;color:var(--text-normal);font-family:inherit;padding:10px 12px;margin-bottom:20px;';
		urlInput.addEventListener('focus', () => { urlInput.style.borderColor = 'var(--interactive-accent)'; });
		urlInput.addEventListener('blur', () => { urlInput.style.borderColor = 'var(--background-modifier-border)'; });

		navigator.clipboard.readText().then(clipText => {
			const url = extractUrl(clipText);
			if (url) { urlInput.value = url; this.url = url; }
		}).catch(() => {});

		urlInput.addEventListener('input', (e: Event) => {
			this.url = (e.target as HTMLInputElement).value;
		});
		urlInput.addEventListener('keydown', (e: KeyboardEvent) => {
			if (e.key === 'Enter' && !this.isProcessing) this.doClip();
		});
		contentEl.appendChild(urlInput);

		// 保存路径（只读文本 + 提示）
		const saveLabel = document.createElement('div');
		saveLabel.textContent = '保存至';
		saveLabel.style.cssText = 'font-size:11px;font-weight:400;color:var(--text-muted);letter-spacing:0.08em;margin-bottom:4px;';
		contentEl.appendChild(saveLabel);

		const pathDisplay = document.createElement('div');
		pathDisplay.textContent = this.settings.savePath;
		pathDisplay.style.cssText = 'font-size:13px;color:var(--text-normal);margin-bottom:4px;';
		contentEl.appendChild(pathDisplay);

		const saveHint = document.createElement('div');
		saveHint.textContent = '可在设置中修改默认保存路径';
		saveHint.style.cssText = 'font-size:11px;color:var(--text-faint);margin-bottom:20px;';
		contentEl.appendChild(saveHint);

		// 底部按钮
		const actions = document.createElement('div');
		actions.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-top:20px;padding-top:16px;border-top:1px solid var(--background-modifier-border);';

		const cancelBtn = document.createElement('span');
		cancelBtn.textContent = '取消';
		cancelBtn.style.cssText = 'display:inline-block;font-size:13px;color:var(--text-muted);cursor:pointer;padding:8px 20px;border:1px solid var(--background-modifier-border);border-radius:6px;background:transparent;user-select:none;';
		cancelBtn.addEventListener('click', () => this.close());
		cancelBtn.addEventListener('mouseenter', () => { cancelBtn.style.color = 'var(--text-normal)'; });
		cancelBtn.addEventListener('mouseleave', () => { cancelBtn.style.color = 'var(--text-muted)'; });
		actions.appendChild(cancelBtn);

		const clipBtn = document.createElement('span');
		clipBtn.textContent = '剪藏';
		clipBtn.style.cssText = 'display:inline-block;font-size:13px;font-weight:500;color:#fff;cursor:pointer;padding:8px 24px;border:none;border-radius:6px;background:#2e7d32;user-select:none;';
		clipBtn.addEventListener('click', () => this.doClip());
		clipBtn.addEventListener('mouseenter', () => { clipBtn.style.opacity = '0.85'; });
		clipBtn.addEventListener('mouseleave', () => { clipBtn.style.opacity = '1'; });
		actions.appendChild(clipBtn);

		contentEl.appendChild(actions);

		urlInput.focus();
	}

	async doClip() {
		if (this.isProcessing) return;
		const url = this.url.trim();
		if (!url) { new Notice('请输入网页链接'); return; }
		if (!url.startsWith('http://') && !url.startsWith('https://')) { new Notice('请输入有效的 URL'); return; }

		this.isProcessing = true;
		try {
			const file = await clipWebPage(url, this.app.vault, this.settings, () => {});
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

	onClose() {
		this.contentEl.empty();
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
	}
}
