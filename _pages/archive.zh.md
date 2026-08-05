---
layout: default
title: 归档
lang: zh
permalink: /archive/
url_en: /en/archive/
---
{% assign t = site.data.zh %}
<section class="archive">
  <div class="wrap wrap-narrow">
    <h1 class="page-title">{{ page.title }}</h1>
    {% assign posts = site.posts | where: "lang", "zh" %}
    {% assign posts_by_year = posts | group_by_exp: "post", "post.date | date: '%Y'" %}
    {% for year in posts_by_year %}
    <h2 class="archive-year">{{ year.name }}</h2>
    <ul class="archive-list">
      {% for post in year.items %}
      <li>
        <a href="{{ post.url | relative_url }}">{{ post.title }}</a>
        <span class="archive-date">{{ post.date | date: "%m-%d" }}</span>
      </li>
      {% endfor %}
    </ul>
    {% endfor %}
  </div>
</section>
