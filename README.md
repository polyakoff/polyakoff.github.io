# artem.im — особистий сайт (Hugo)

Двомовний (укр/англ) блог на Hugo. Деплой — GitHub Pages через GitHub Actions.

## Як додати новий пост
- Створи теку `content/blog/назва-поста/` і в ній `index.uk.md` (і за бажанням `index.en.md`).
- Front matter + текст у Markdown:
  ```
  ---
  title: "Заголовок"
  slug: "url-poslannya"
  date: 2026-07-01
  description: "Опис для Google (SEO)."
  ---
  Текст посту…
  ```
- Commit у `main` → за хвилину пост у мережі. Він автоматично з'явиться в лівому меню та на головній.
- Можна робити прямо на github.com (Add file → Create new file), без терміналу.

## Локальний перегляд (необов'язково)
Встанови Hugo extended і запусти `hugo server` у теці проєкту → http://localhost:1313

## Вже налаштовано
- Двомовність uk/en (перемикач у меню), ліве дерево-меню → бургер на мобільному.
- SEO: sitemap.xml, robots.txt, RSS, canonical, hreflang, Open Graph.
- Лічильник GoatCounter (poliakoff.goatcounter.com) — рахує лише на проді.
- Перший пост = твій звіт про житло для ВПО (інтерактив у `static/reports/eoselia-vpo.html`).
