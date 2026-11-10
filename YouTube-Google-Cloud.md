# YouTube в Crossember: регистрация в Google Cloud (один раз, ~15 минут)

Это нужно, чтобы друзья входили в YouTube одной кнопкой «Войти» (как с Twitch). Делается один раз, на твоём аккаунте Google.

## 1. Проект
1. Открой https://console.cloud.google.com/ и войди своим аккаунтом Google.
2. Вверху слева — выбор проекта → **New Project**. Название: `Crossember`. **Create**.
3. Убедись, что вверху выбран проект `Crossember`.

## 2. Включить YouTube Data API v3
1. Меню ☰ → **APIs & Services** → **Library**.
2. Найди **YouTube Data API v3** → **Enable**.

## 3. Экран согласия (то, что увидят друзья при входе)
1. ☰ → **APIs & Services** → **OAuth consent screen** (может называться **Google Auth Platform → Branding**). **Get started**.
2. App name: `Crossember`. User support email: твоя почта.
3. Audience: **External**.
4. Contact information: твоя почта. Согласиться с правилами → **Create**.
5. Раздел **Data Access** → **Add or remove scopes** → найди и отметь
   `https://www.googleapis.com/auth/youtube.force-ssl` → **Update** → **Save**.
6. Раздел **Audience** → **Publish app** → подтвердить. Статус станет **In production**.
   - Зачем: в режиме Testing вход «слетает» каждые 7 дней.
   - Верификацию Google проходить НЕ нужно. Друзья при входе увидят предупреждение
     «Google не проверил это приложение» → **Дополнительно** → **Перейти на сайт Crossember**. Это нормально.
   - Лимит без верификации — 100 пользователей, нам хватит.

## 4. OAuth-клиент
1. Раздел **Clients** (или **APIs & Services → Credentials**) → **Create client** / **Create credentials → OAuth client ID**.
2. Application type: **Desktop app**. Name: `Crossember Desktop`. **Create**.
3. Появятся **Client ID** (`…apps.googleusercontent.com`) и **Client secret** (`GOCSPX-…`).

## 5. Что прислать
Пришли в чат Claude **Client ID** и **Client secret**.
- Они хранятся в файле `app/resources/youtube/oauth-client.json`. В Git он не попадает: GitHub блокирует
  такие ключи при push, а Google отзывает засвеченные. В сборку программы для друзей файл входит.
- Альтернатива — вписать свои ключи только у себя: «Подключения → YouTube → Для опытных».

## Квота
У проекта 10 000 единиц в сутки на ВСЕХ пользователей. Crossember экономит: поиск эфира раз в 2 мин (1 ед.),
онлайн раз в 90 с в эфире (1 ед.), чат — одно потоковое соединение (5 ед.). Если не хватит — в Google Cloud
можно подать заявку на увеличение квоты (бесплатно): **APIs & Services → YouTube Data API v3 → Quotas**.
