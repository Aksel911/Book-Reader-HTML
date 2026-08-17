# 📚 Умный Читатель v2.2

Офлайн-читатель книг для iPhone (Safari) на чистом HTML/CSS/JS.

## Форматы

| Формат | Статус |
|--------|--------|
| PDF | ✅ PDF.js |
| EPUB | ✅ epub.js + TOC |
| FB2 | ✅ нативный парсер |
| **DJVU** | ✅ **DjVu.js Viewer** |
| TXT / HTML | ✅ |
| ZIP | ✅ вход внутрь архива |
| RAR | ⚠️ лучше ZIP |

## Возможности

- Выбор папки с книгами (включая подпапки)
- ZIP-архивы: клик → вход внутрь → книги внутри
- Умная озвучка + подсветка предложений
- ⭐ Избранное и теги
- Закладки, оглавление, поиск в книге
- Таймер сна, статистика, темы
- Экспорт прогресса

## Что изменено в текущей версии

- Переработан стартовый экран и библиотека в более книжном/editorial стиле.
- Добавлен отдельный iPhone-friendly выбор нескольких файлов.
- Поиск по библиотеке учитывает относительные пути; одинаковые названия из разных подпапок не смешиваются.
- Прогресс, закладки, избранное и EPUB-позиции используют стабильный ключ на основе пути.
- ZIP-файлы можно открывать с вложенностью; для файлов внутри архива ключ включает источник архива.
- TTS разбивается на короткие фрагменты, что лучше подходит мобильному `speechSynthesis`.
- Добавлены `100dvh`, safe-area и мобильная нижняя панель для side panel.

## Проверка

Локально проверено: синтаксис `app.js`, JSON `manifest.json`, наличие всех локальных библиотек и базовая отдача проекта через `python -m http.server`. Chromium/Playwright в окружении был доступен, но доступ браузера к локальному `127.0.0.1`/`file://` здесь заблокирован политикой среды, поэтому интерактивный smoke-test браузера не удалось завершить.


---

## 🚀 Деплой на GitHub Pages

### Автоматический деплой (рекомендуется)

**macOS / Linux:**

```bash
cd book-reader
chmod +x deploy.sh
./deploy.sh
```

Или с именем репозитория:

```bash
./deploy.sh Book-Reader-HTML
./deploy.sh username/Book-Reader-HTML
```

**Windows — двойной клик (рекомендуется):**

Просто запусти файл **`deploy.bat`** двойным кликом.

Или из cmd:
```bat
cd book-reader
deploy.bat
```

**Windows (PowerShell):**

```powershell
cd book-reader
.\deploy.ps1
```

Репозиторий по умолчанию: **`Book-Reader-HTML`**  
Адрес сайта: `https://ТВОЙ-ЛОГИН.github.io/Book-Reader-HTML/`

Скрипт сам:
1. Инициализирует git (если нужно)
2. Создаст репозиторий на GitHub (через `gh`)
3. Запушит код
4. Включит GitHub Pages
5. Покажет ссылку на сайт

**Нужно один раз:** установить [Git](https://git-scm.com) и [GitHub CLI](https://cli.github.com), затем `gh auth login`.

---

### Способ 1 — через сайт GitHub (без терминала)

1. Зайди на [github.com](https://github.com) и войди в аккаунт (или зарегистрируйся).

2. Нажми **New repository** (зелёная кнопка).
   - **Repository name:** например `Book-Reader-HTML`
   - Поставь галочку **Public**
   - **Не** ставь «Add a README» — репозиторий должен быть пустым
   - Create repository

3. На странице нового репозитория нажми **uploading an existing file**.

4. Перетащи **всё содержимое** папки `book-reader` (не саму папку, а файлы внутри):
   ```
   index.html
   styles.css
   app.js
   manifest.json
   README.md
   libs/
     djvu.js
     djvu_viewer.js
   ```
   Важно: `index.html` должен оказаться **в корне** репозитория, а не в подпапке.

5. Внизу нажми **Commit changes**.

6. Открой **Settings** → слева **Pages**.

7. В блоке **Build and deployment**:
   - **Source:** Deploy from a branch
   - **Branch:** `main` (или `master`) → папка `/ (root)`
   - Save

8. Подожди 1–2 минуты. Сверху появится ссылка вида:
   ```
   https://ТВОЙ-ЛОГИН.github.io/Book-Reader-HTML/
   ```

9. Открой эту ссылку в **Safari на iPhone**.

10. (Опционально) «Поделиться» → **На экран «Домой»** — иконка как у приложения.

---

### Способ 2 — через Git (терминал)

Если Git уже установлен:

```bash
# 1. Распакуй архив и зайди в папку
cd book-reader

# 2. Инициализируй репозиторий
git init
git add .
git commit -m "Умный Читатель — первая версия"

# 3. Создай пустой репозиторий на GitHub (Public), затем:
git branch -M main
git remote add origin https://github.com/ТВОЙ-ЛОГИН/Book-Reader-HTML.git
git push -u origin main
```

Дальше как в способе 1, шаги 6–10: **Settings → Pages → Deploy from a branch → main / root**.

---

### Способ 3 — быстро через GitHub CLI

```bash
cd book-reader
gh repo create book-reader --public --source=. --remote=origin --push
# Затем Settings → Pages → main / root
```

---

## 📱 Как пользоваться на iPhone

1. Открой ссылку GitHub Pages в **Safari** (не Chrome — для «На экран Домой» лучше Safari).
2. Выбери папку или файлы с книгами.
3. Читай, озвучивай, ставь ⭐ и теги.
4. Добавь на домашний экран: Поделиться → На экран «Домой».

### Импорт на iPhone

- **Сканировать папку** использует `webkitdirectory`: когда Safari отдаёт иерархию файлов, приложение получает **все книги из подпапок** и сохраняет относительный путь.
- **Выбрать файлы** — универсальный fallback для Safari/iOS, когда выбор папки недоступен. Можно отметить сразу много файлов.
- На настольном браузере также можно перетащить файлы в стартовый экран.

### Архивы ZIP

В библиотеке ZIP отображается как 📦. Нажми → увидишь книги внутри → можно заходить во вложенные архивы. Назад — по «хлебным крошкам» вверху.

---

## Структура проекта

```
book-reader/
├── index.html          # Главная страница
├── styles.css          # Стили
├── app.js              # Логика
├── manifest.json       # PWA
├── libs/
│   ├── djvu.js         # Движок DJVU
│   └── djvu_viewer.js  # Просмотрщик DJVU
└── README.md
```

## Локальный запуск (для проверки)

```bash
npx serve .
# или
python3 -m http.server 8080
```

Открой `http://localhost:3000` (или 8080) в браузере.

---

Приятного чтения! 📖


## Library v4 performance
- Real imported folders are shown as navigable folders instead of a flat wall of books.
- Only 60 book cards are mounted initially; more are added on demand.
- PDF covers are lazy-loaded only near the viewport, with at most two renders in parallel.
- Generated PDF thumbnails are cached in IndexedDB and reused on subsequent visits.
- TTS highlights the actual reading surface in yellow for text-based books, EPUB and PDF text layers instead of relying on a separate caption panel.
