# Krunica – molitva dana

Osobna web-aplikacija za molitvu krunice na hrvatskom: krunica korak po korak, otajstva prema danu i liturgijskom vremenu, Lauretanske litanije, čitanja dana (HILP), komentar (Book.hr) i molitve (Bog je tu).

- Aplikacija: `index.html` (GitHub Pages)
- Dnevno osvježavanje: `.github/workflows/update.yml` → `scripts/fetch.mjs`
- Tekstovi čitanja, komentara i molitava spremaju se **šifrirano** (tajna `KRUNICA_KEY`) i služe samo za osobnu molitvu. Prava na tekstove imaju njihovi izdavači.
