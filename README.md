# Easy Web Clipper - Obsidian 网页剪藏插件

> **Obsidian 一直缺少一个好用的网页剪藏插件**——现有的方案要么需要配合外部服务，要么提取质量差，要么根本不可用。Easy Web Clipper 填补了这个空白：**在 Obsidian 内粘贴链接，一键将网页内容剪藏为干净的 Markdown 笔记**，无需任何外部依赖。

> **Obsidian has been lacking a good web clipper plugin** — existing solutions either require external services, produce poor extraction quality, or simply don't work. Easy Web Clipper fills this gap: **paste a link inside Obsidian and clip web content into clean Markdown notes in one click**, with zero external dependencies.

---

[中文文档](#中文文档) | [English Documentation](#english-documentation)

---

<a id="中文文档"></a>

## 为什么选择 Easy Web Clipper？

市面上大多数 Obsidian 剪藏方案都需要借助浏览器扩展、第三方服务或命令行工具。Easy Web Clipper 是**少有的纯 Obsidian 内置方案**——不装浏览器扩展，不依赖外部服务，粘贴链接就能用。

核心优势：

- 📌 **零外部依赖**：不需要浏览器扩展、不需要服务器、不需要 API Key，粘贴链接即用
- ✂️ **一键剪藏**：Ribbon 图标或命令面板，粘贴 URL 即可剪藏
- 🧹 **智能内容提取**：基于 Mozilla Readability.js 引擎（Firefox 阅读模式同款），自动识别正文，去除广告、导航、页脚、备案号等噪音
- 📝 **高质量 Markdown 输出**：使用 Turndown + GFM 插件转换，保留标题、段落、列表、表格、图片等格式
- 🏷️ **自动 Front Matter**：生成 YAML 元数据（标题、来源、作者、日期、摘要）
- 📋 **剪贴板感知**：自动识别剪贴板中的 URL，一键剪藏
- ⚙️ **灵活配置**：自定义保存路径、文件名模板、Front Matter 字段
- 🖼️ **排版保留**：尽可能保持原文结构，包括图片、表格、代码块等

## 安装方法

### 通过社区插件商店安装（推荐）

1. 打开 Obsidian 设置 → 第三方插件
2. 关闭安全模式（如已开启）
3. 浏览社区插件，搜索 "Easy Web Clipper"
4. 点击安装并启用

### 手动安装

1. 从 [GitHub Releases](https://github.com/gibsonchan-5/easy-web-clipper/releases) 下载最新版本的 `main.js`、`manifest.json`、`styles.css`

2. 在 Obsidian 仓库目录下创建插件文件夹，将上述文件复制进去：
   ```
   您的仓库/.obsidian/plugins/easy-web-clipper/
   ```

3. 在 Obsidian 中启用插件：
   - 打开设置 → 第三方插件
   - 找到 "Easy Web Clipper" 并启用

### 从源码构建

```bash
# 克隆或下载项目
git clone https://github.com/gibsonchan-5/easy-web-clipper.git
cd easy-web-clipper

# 安装依赖
npm install

# 开发模式（监听文件变化）
npm run dev

# 生产构建
npm run build
```

然后将生成的 `main.js`、`manifest.json`、`styles.css` 复制到 Obsidian 插件目录。

## 使用方法

### 1. 通过 Ribbon 图标剪藏

点击 Obsidian 左侧边栏的剪刀图标，在弹出的对话框中粘贴网页链接，点击"开始剪藏"。

### 2. 通过命令面板剪藏

1. 按 `Ctrl/Cmd + P` 打开命令面板
2. 输入 "Easy Web Clipper" 或 "剪藏网页"
3. 选择相应命令

### 3. 剪藏剪贴板中的 URL

1. 复制网页链接到剪贴板
2. 按 `Ctrl/Cmd + P` 打开命令面板
3. 选择 "Easy Web Clipper: 剪藏剪贴板中的链接"

### 4. 设置

在插件设置中可以配置：

- **保存路径**：剪藏笔记保存的文件夹路径（相对于 Obsidian 仓库根目录）
- **文件名模板**：支持变量 `{{title}}`、`{{date}}`、`{{time}}`
- **Front Matter 选项**：
  - 是否包含 Front Matter
  - 是否包含标题、来源 URL、作者、日期、摘要
- **打开方式**：剪藏后是否自动打开新笔记

## 配置示例

### 默认设置

```json
{
  "savePath": "剪藏",
  "fileNameTemplate": "{{title}}",
  "includeFrontMatter": true,
  "includeTitle": true,
  "includeSourceUrl": true,
  "includeAuthor": true,
  "includeDate": true,
  "includeExcerpt": true,
  "openAfterClip": true
}
```

### 自定义文件名模板

- `{{title}}` - 使用网页标题
- `{{date}}` - 使用日期（格式：YYYY-MM-DD）
- `{{time}}` - 使用时间（格式：HH-mm）

示例：
- `{{date}}-{{title}}` → `2026-08-12-文章标题.md`
- `{{title}}-{{date}}` → `文章标题-2026-08-12.md`

## 技术实现

- **内容提取**：使用 Mozilla 的 [Readability.js](https://github.com/mozilla/readability)，这是 Firefox 阅读模式使用的同款引擎
- **HTML 清洗**：自定义多层清洗规则，移除广告、导航、页脚、备案号等噪音内容
- **Markdown 转换**：使用 [Turndown](https://github.com/mixmark-io/turndown) 及其 GFM 插件
- **网络请求**：使用 Obsidian 的 `requestUrl` API

## 智能清洗规则

插件会自动移除以下内容：

- 广告和赞助内容
- 导航栏和菜单
- 页脚信息和备案号
- 社交媒体分享按钮
- 评论区
- 相关推荐
- 弹窗和模态框
- Cookie 提示
- 空链接和无意义元素
- 版权声明和免责声明

## 生成的笔记示例

```markdown
---
title: "文章标题"
source: https://example.com/article
author: "作者名"
date: 2026-08-12
excerpt: "文章摘要..."
---

# 文章标题

正文内容...

## 小节标题

更多内容...

- 列表项 1
- 列表项 2

![图片描述](https://example.com/image.jpg)
```

## 常见问题

**Q: 无法剪藏某个页面？**
A: 可能是该页面需要 JavaScript 渲染或需要登录。目前插件只能处理服务端渲染的 HTML 内容。

**Q: 提取的内容包含很多无关信息？**
A: 某些网站结构特殊，Readability 可能无法完美识别。可以手动编辑清理。

**Q: 图片无法显示？**
A: 图片保留了原始 URL，部分网站可能有防盗链。右键图片 → 复制图片 → 粘贴到笔记中可手动保存。

## 开发计划

- [ ] 支持下载图片到本地
- [ ] 支持批量剪藏（多个链接）
- [ ] 支持自定义清洗规则（CSS 选择器）
- [ ] 支持模板化输出（自定义 Markdown 模板）
- [ ] 支持代理设置（应对反爬）

## 许可证

MIT License

## 反馈和问题

如果您遇到问题或有建议，欢迎在 [GitHub Issues](https://github.com/gibsonchan-5/easy-web-clipper/issues) 中反馈！

---

<a id="english-documentation"></a>

## Why Easy Web Clipper?

Most Obsidian clipping solutions require browser extensions, third-party services, or command-line tools. Easy Web Clipper is a **rare pure in-app solution** — no browser extensions, no external services, just paste a link and go.

Key features:

- 📌 **Zero external dependencies**: No browser extension, no server, no API key — just paste a link
- ✂️ **One-click clipping**: Clip via Ribbon icon or Command Palette
- 🧹 **Smart content extraction**: Powered by Mozilla's Readability.js (same engine as Firefox Reader View), automatically identifies article body and removes ads, navigation, footers, and other noise
- 📝 **High-quality Markdown output**: Uses Turndown + GFM plugin to preserve headings, paragraphs, lists, tables, images, and more
- 🏷️ **Automatic Front Matter**: Generates YAML metadata (title, source, author, date, excerpt)
- 📋 **Clipboard-aware**: Auto-detects URLs in clipboard for one-click clipping
- ⚙️ **Flexible configuration**: Customizable save path, file name template, and Front Matter fields
- 🖼️ **Layout preservation**: Maintains original structure including images, tables, and code blocks

## Installation

### Install via Community Plugins (Recommended)

1. Open Obsidian Settings → Community Plugins
2. Turn off Safe Mode (if enabled)
3. Browse community plugins and search for "Easy Web Clipper"
4. Click Install and Enable

### Manual Installation

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest [GitHub Release](https://github.com/gibsonchan-5/easy-web-clipper/releases)

2. Create a plugin folder in your Obsidian vault and copy the files:
   ```
   YourVault/.obsidian/plugins/easy-web-clipper/
   ```

3. Enable the plugin in Obsidian:
   - Go to Settings → Community Plugins
   - Find "Easy Web Clipper" and enable it

### Build from Source

```bash
# Clone or download the project
git clone https://github.com/gibsonchan-5/easy-web-clipper.git
cd easy-web-clipper

# Install dependencies
npm install

# Development mode (watch for changes)
npm run dev

# Production build
npm run build
```

Then copy the generated `main.js`, `manifest.json`, and `styles.css` to your Obsidian plugin directory.

## Usage

### 1. Clip via Ribbon Icon

Click the scissors icon in the left sidebar, paste the URL in the dialog, and click "Clip".

### 2. Clip via Command Palette

1. Press `Ctrl/Cmd + P` to open the Command Palette
2. Type "Easy Web Clipper" or "Clip Web Page"
3. Select the desired command

### 3. Clip URL from Clipboard

1. Copy a web page URL to your clipboard
2. Press `Ctrl/Cmd + P` to open the Command Palette
3. Select "Easy Web Clipper: Clip URL from Clipboard"

### 4. Settings

Configure in the plugin settings:

- **Save Path**: Folder path for clipped notes (relative to vault root)
- **File Name Template**: Supports `{{title}}`, `{{date}}`, `{{time}}` variables
- **Front Matter Options**:
  - Include Front Matter
  - Include title, source URL, author, date, excerpt
- **Open After Clip**: Auto-open the newly created note

## Configuration Example

### Default Settings

```json
{
  "savePath": "Clippings",
  "fileNameTemplate": "{{title}}",
  "includeFrontMatter": true,
  "includeTitle": true,
  "includeSourceUrl": true,
  "includeAuthor": true,
  "includeDate": true,
  "includeExcerpt": true,
  "openAfterClip": true
}
```

### File Name Template Variables

- `{{title}}` - Web page title
- `{{date}}` - Date (format: YYYY-MM-DD)
- `{{time}}` - Time (format: HH-mm)

Examples:
- `{{date}}-{{title}}` → `2026-08-12-Article-Title.md`
- `{{title}}-{{date}}` → `Article-Title-2026-08-12.md`

## Technical Details

- **Content extraction**: Mozilla's [Readability.js](https://github.com/mozilla/readability) — the same engine behind Firefox Reader View
- **HTML cleaning**: Multi-layer custom cleaning rules to remove ads, navigation, footers, and other noise
- **Markdown conversion**: [Turndown](https://github.com/mixmark-io/turndown) with GFM plugin
- **Network requests**: Obsidian's built-in `requestUrl` API

## Smart Cleaning Rules

The plugin automatically removes:

- Ads and sponsored content
- Navigation bars and menus
- Footer information and ICP filing numbers
- Social media sharing buttons
- Comment sections
- Related article recommendations
- Popups and modals
- Cookie consent banners
- Empty links and meaningless elements
- Copyright notices and disclaimers

## Example Output

```markdown
---
title: "Article Title"
source: https://example.com/article
author: "Author Name"
date: 2026-08-12
excerpt: "Article excerpt..."
---

# Article Title

Article body content...

## Section Heading

More content...

- List item 1
- List item 2

![Image description](https://example.com/image.jpg)
```

## FAQ

**Q: Can't clip a certain page?**
A: The page may require JavaScript rendering or login. The plugin currently only processes server-rendered HTML content (e.g., pages built with React/Vue client-side rendering like Notion, GitHub Discussions, etc. may not work).

**Q: Extracted content contains too much irrelevant information?**
A: Some websites have unusual structures that Readability can't perfectly identify. You can manually edit and clean up the result.

**Q: Images not showing?**
A: Images retain their original URLs. Some sites may have hotlink protection. Right-click the image → Copy Image → Paste into your note to save manually.

## Roadmap

- [ ] Download images locally
- [ ] Batch clipping (multiple links)
- [ ] Custom cleaning rules (CSS selectors)
- [ ] Templated output (custom Markdown templates)
- [ ] Proxy support (anti-scraping)

## License

MIT License

## Feedback & Issues

If you encounter any problems or have suggestions, feel free to open an issue on [GitHub](https://github.com/gibsonchan-5/easy-web-clipper/issues)!
