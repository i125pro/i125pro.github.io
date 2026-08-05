# i125pro.github.io — 开发文档

## 项目概述
仿 pi.dev (https://pi.dev/packages/pi-yuanbao) 设计风格的 Jekyll 博客，中英双语支持，部署在 GitHub Pages。

- 仓库: https://github.com/i125pro/i125pro.github.io
- 线上: https://i125pro.github.io
- 技术栈: Jekyll 4.x + SCSS + 原生 JS（无框架）

## 目录结构

```
.
├── _config.yml          # Jekyll 配置，含双语设置 zh/en, future:true
├── Gemfile               # jekyll ~4.4, minima, jekyll-feed/seo-tag/sitemap
├── _data/
│   ├── zh.yml            # 中文 UI 字符串（nav/hero/footer/post/theme/lang）
│   └── en.yml            # 英文 UI 字符串
├── _layouts/
│   ├── default.html      # 基础布局，引入 head/header/footer
│   ├── home.html          # 首页布局：.hero + .post-list
│   ├── page.html          # 普通页面布局：.page
│   └── post.html          # 文章布局：.post
├── _includes/
│   ├── head.html          # <head>，含暗色/亮色主题初始化脚本 + main.css 引用
│   ├── header.html        # 导航栏：.site-header .wrap .logo .site-nav .site-actions .icon-btn .lang-switch
│   └── footer.html        # 页脚：.site-footer .wrap
├── _sass/                 # ⚠️ 全部是设计系统核心文件
│   ├── _tokens.scss       # 颜色/字体设计令牌（暗色+亮色主题），必须最先 @import
│   ├── base.scss          # reset、网格纸背景纹理、暗角、serif 正文字体
│   ├── header.scss        # 导航栏样式（玻璃拟态、粘性定位）
│   ├── home.scss          # 首页 hero + 文章列表样式
│   ├── footer.scss        # 页脚样式
│   └── page.scss          # 文章/普通页/归档页排版、代码块样式
├── assets/
│   ├── css/main.scss       # ⚠️必须是 .scss 后缀！按顺序 @import 上面 6 个分片
│   └── js/theme.js         # 主题切换逻辑：data-theme 属性 + localStorage
├── _pages/                # about/projects/archive/news，每个都有 .zh.md 和 .en.md
├── _posts/                 # 博客文章，命名 YYYY-MM-DD-slug.md（英文版加 -en 后缀)
├── index.md                # 中文首页 (layout: home)
└── en/index.md             # 英文首页
```

## 设计系统（pi.dev 视觉语言）

### 颜色令牌 (_sass/_tokens.scss)
暗色（默认）:
- `--bg-deep: #0d1116`（最底层背景/暗角终点）
- `--bg-canvas: #161d27`（body 主背景）
- `--panel: #212730e6`（卡片/导航面板背景）
- `--panel-soft: #252f3dd1`（次级面板）
- `--text: #ebe7e4`（正文）
- `--muted: #9fa4abad`（次要文字）
- `--accent: #6a9fcc`（蓝色强调）
- `--accent-rust: #8f3222`（备用强调色）
- `--line: #49505980`（边框线）

亮色 (`[data-theme="light"]`):
- `--bg-deep: #dacbc2` `--bg-canvas: #ebe7e4` `--panel: #f4f2f0e6`
- `--text: #252f3df5` `--accent: #4b607c` `--line: #25303c33`

### 字体
- `--font-serif: "Plantin MT Pro", "Plantin MT Std", Plantin, Georgia, serif` — 正文/标题（本机无该商业字体，回退到 Georgia）
- `--font-mono: "Commit Mono", "SFMono-Regular", Consolas, monospace` — 代码/UI
- `--font-mono-accent: "Departure Mono", "Commit Mono", monospace` — 导航/标签大写小字（letter-spacing: 0.08em）

### 视觉特效
- `body::before` — 网格纸背景纹理（repeating-linear-gradient 横竖各一条，24px 间距）
- `body::after` — 暗角效果（radial-gradient 从透明到 --bg-deep）
- `.site-header .wrap` — 玻璃拟态导航面板（linear-gradient + backdrop-filter: blur(12px) + 内外阴影），position: sticky
- 主题切换通过 `data-theme="light"|"dark"` 属性 + `assets/js/theme.js` 读写 localStorage

## 已知坑 / 踩过的雷

1. **`assets/css/main.scss` 必须是 `.scss` 后缀，不能是 `.css`。** Jekyll 只编译 `.scss`/`.sass` 后缀文件；早期误命名为 `main.css` 导致 Sass `@import` 语句原样输出、样式完全失效（曾导致"没有动态效果，布局很乱，颜色也不对"的问题）。文件头部必须保留 front matter 空行 `---\n---` 才会触发 Jekyll 处理。

2. **`_tokens.scss` 必须在 `main.scss` 里第一个被 `@import`**，其余分片都依赖它定义的 CSS 变量。

3. **GitHub PAT 若无 `workflow` scope，无法 push 修改 `.github/workflows/*.yml`。** 本项目已移除自定义 workflow，改用 GitHub Pages 内置的"Deploy from a branch"构建方式（Settings → Pages → Source = main/root），无需 Actions 权限。

4. **本机访问 github.com 需要代理**（本机走 v2ray 本地代理，端口 10808）。Git 已配置：
   ```
   git config --global http.proxy http://127.0.0.1:10808
   git config --global https.proxy http://127.0.0.1:10808
   ```
   若换机器/环境需要重新配置或移除。

5. **不要在 git remote URL 里明文写 token**（如 `https://user:TOKEN@github.com/...`）。推送认证应通过 Git Credential Manager（Windows 自带）或 `gh auth login`，remote URL 保持纯净：`https://github.com/i125pro/i125pro.github.io.git`。

6. 本机未安装 Ruby/Jekyll/gh CLI，无法本地 `bundle exec jekyll serve` 预览或用 `gh` 操作 GitHub，所有验证都是靠直接 curl 线上站点确认。

## 待完善 / 后续可开发方向

- 字体：`Plantin MT Pro`/`Commit Mono`/`Departure Mono` 是商业字体，当前用系统字体回退（Georgia/Consolas）。可考虑自托管开源近似字体（如 serif 用 Source Serif 4 或 PT Serif，mono 用 JetBrains Mono）来更接近 pi.dev 真实效果，同时不侵权。
- 头像、favicon、OG 图片未设置（`head.html` 里 `<link rel="icon" href="data:,">` 是占位空图标）。
- `_pages/*.md` 内容目前是脚手架占位文字，需要真实填充 about/projects/archive/news 内容。
- 归档页 `_pages/archive.*.md` 的 Liquid 逐年分组逻辑需要用真实文章验证渲染效果。
- 未做移动端详细适配测试（仅 header.scss 里有一条 `@media (max-width:640px)` 隐藏导航链接的规则）。
- 未接入评论系统、搜索、RSS 展示页等常见博客功能（`jekyll-feed` 插件已装但未在模板里加订阅入口链接）。

## 常用命令

```bash
# 本机若装了 Ruby/Jekyll：
bundle install
bundle exec jekyll serve   # 本地预览 http://localhost:4000

# git 推送（需代理）：
cd "D:/code ss/i125pro.github.io"
git add -A && git commit -m "message"
git push origin main
```

## 关键提交历史
- `03e636c` Initial Jekyll site scaffold: pi.dev-inspired design, zh/en bilingual support
- `2abf735` Redesign CSS to match pi.dev visual system (tokens, header, home, page, footer)
- `127b1bd` Remove custom GitHub Actions workflow; use built-in Pages Jekyll build
- `d9ef073` Fix: rename main.css to main.scss so Jekyll actually compiles the Sass partials
