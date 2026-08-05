---
layout: default
title: Archive
lang: en
permalink: /en/archive/
url_zh: /archive/
---
<section class="archive">
  <div class="wrap wrap-narrow">
    <h1 class="page-title">{{ page.title }}</h1>
    {% assign posts = site.posts | where: "lang", "en" %}
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
