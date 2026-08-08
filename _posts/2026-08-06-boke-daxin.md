---
title: "第一次搭这个博客的一些想法"
lang: zh
---

今天把博客的框架搭好了，用 Jekyll + GitHub Pages，样式仿照 [pi.dev](https://pi.dev) 的克制风格：暗色为主，衬线正文字体，等宽字体用在导航和代码上。

搭建过程中踩了几个坑，记一下：

1. **CSS 文件必须以 `.scss` 结尾**。一开始随手叫了 `main.css`，结果 Sass 的 `@import` 语句原样被当成文本输出到页面里，样式完全没生效——布局乱、颜色不对，看起来非常诡异。改成 `.scss` 后缀，Jekyll 才会真正编译它。

2. **本机没装 Ruby/Jekyll**，没法本地跑 `jekyll serve` 预览效果，所有验证都得推到 GitHub 上，靠直接访问线上地址来确认。这意味着每次改动最好小步提交，方便出问题时回退。

3. GitHub Pages 用**内置的 Jekyll 构建**（Settings → Pages → Source 选分支），不需要自己写 GitHub Actions workflow，也就不需要 PAT 的 `workflow` 权限，省了不少麻烦。

接下来准备把 `about`、`projects`、`archive` 这几个页面的占位内容换成真实的，再考虑要不要接个评论系统。这篇算是给未来的自己留个记录，也顺便当作博客怎么写的一个真实案例——正文里可以随便聊技术细节、踩坑经历，也可以夹带一点感想，不用刻意端着。
