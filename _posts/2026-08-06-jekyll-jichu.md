---
title: "用 Jekyll 写博客：Front Matter 与文件命名"
lang: zh
---

写这个博客用的是 Jekyll。每篇文章放在 `_posts/` 目录下，文件名必须是这个格式：

```
YYYY-MM-DD-slug.md
```

比如这篇文章的文件名是 `2026-08-06-jekyll-jichu.md`，日期会自动成为发布时间，`slug` 部分会出现在 URL 里。

## Front Matter 是什么

每个 Markdown 文件最上面用 `---` 包起来的一段叫 Front Matter，是 YAML 格式的元数据：

```yaml
---
title: "文章标题"
lang: zh
---
```

- `title` 会显示在文章顶部和列表里
- `lang` 决定用中文还是英文的界面文案（页脚、"发布于"这类字样）

写英文版文章时，文件名加 `-en` 后缀（如 `2026-08-06-jekyll-jichu-en.md`），并且要加一行 `permalink`，否则中英文版会共用同一个网址导致冲突：

```yaml
---
title: "..."
lang: en
permalink: /en/:year/:month/:day/:title/
---
```

## Front Matter 之后就是正文

正文部分用普通 Markdown 写就行——标题、段落、链接、图片，都是标准语法。Front Matter 和正文之间要留一个空行，不然会被当成正文的一部分。

写完之后 `git add -A && git commit -m "..." && git push`，GitHub Pages 会自动构建并发布到 [i125pro.github.io](https://i125pro.github.io)。
