---
title: "Markdown 常用语法速查：代码块、列表与引用"
lang: zh
---

这篇演示博客里最常用的几种排版元素，写自己的文章时可以直接照抄。

## 代码块

行内代码用单个反引号包住，比如 `git push origin main`。

多行代码用三个反引号，并在后面写上语言名（这样才会有语法高亮，样式在 [page.scss](https://github.com/i125pro/i125pro.github.io/blob/main/_sass/page.scss) 里定义）：

```bash
cd "D:/code ss/i125pro.github.io"
git add -A
git commit -m "add new post"
git push origin main
```

```python
def greet(name: str) -> str:
    return f"Hello, {name}!"
```

## 列表

无序列表：

- 第一点
- 第二点
- 第三点，可以再嵌套一层
  - 嵌套项 A
  - 嵌套项 B

有序列表：

1. 先写文章的 Markdown 文件
2. 放进 `_posts/` 目录，按日期命名
3. 提交并推送到 GitHub

## 引用

> 简洁的排版、清晰的层级——这是 [pi.dev](https://pi.dev) 给这个博客的设计灵感。

## 二级标题的用法

`##` 二级标题会自动获得比正文更大的衬线字体和留白（见 `page.scss` 里的 `.post-content h2` 规则），用来分隔文章的不同部分。目前样式只写到 `h2`，如果需要 `h3` 及更深层级，需要自己在 `_sass/page.scss` 里补上对应样式。
