# Деплой на сервер

Короткая инструкция для запуска на сервере. Подробности — в [README.md](README.md).

> Контекст для сессии на сервере: это связка «сервер-relay + админка + Chrome-расширение»
> для просмотра почты (только чтение). Админ загружает аккаунты (строки формата
> `email----password----client_id----refresh_token----…` для Outlook/Hotmail, либо
> `email:password`), прокси и ключи доступа. Сотрудник в расширении вставляет строку
> аккаунта целиком; сервер пускает к почте только если такая строка есть в базе (сверка
> по хешу) и ходит в IMAP только через прокси. Outlook/Hotmail — вход по OAuth
> (refresh_token + client_id). Отправки писем нет.

## 1. Требования
- Node.js **22.5+** (нужен встроенный `node:sqlite`) **или** Docker + docker compose.
- Домен за Cloudflare (для туннеля), если хотим скрыть входной IP.

## 2. Клонирование
```bash
git clone <URL-репозитория> mail-viewer
cd mail-viewer/server
```

## 3. Конфигурация
```bash
cp .env.example .env
```
Заполнить в `.env`:
- `ADMIN_PASSWORD` — длинный пароль входа в админку (16+ символов).
- `SECRET_KEY` — `openssl rand -hex 32` (шифрование сохранённого в БД; без него создастся
  автоматически в `data/secret.key` — **бэкапить этот файл**).
- `REQUIRE_PROXY=true` (оставить).
- `TRUST_PROXY_HEADERS=true` — только потому, что за Cloudflare/nginx.

## 4a. Запуск через Docker (рекомендуется)
```bash
docker compose up -d --build        # слушает 127.0.0.1:8787
curl localhost:8787/health          # -> {"ok":true}
```

## 4b. Запуск без Docker
```bash
npm install --omit=dev
npm start                           # 127.0.0.1:8787
# постоянно — через systemd:
#   sudo cp mail-viewer.service /etc/systemd/system/
#   (поправить WorkingDirectory/пользователя), sudo systemctl enable --now mail-viewer
```

## 5. Скрыть входной IP (Cloudflare Tunnel)
1. Cloudflare Zero Trust → создать туннель → получить токен.
2. Публичный хостнейм `mail.ДОМЕН` → `http://mail-viewer:8787` (Docker) или `http://127.0.0.1:8787`.
3. ```bash
   echo "CLOUDFLARE_TUNNEL_TOKEN=токен" >> .env
   docker compose --profile tunnel up -d
   ```
Адрес сервера для расширения: `https://mail.ДОМЕН` (обязательно https).

## 6. Наполнение
Открыть `https://mail.ДОМЕН` → войти по `ADMIN_PASSWORD`:
- **Прокси** → добавить пул (socks5 рекомендуется).
- **Почты** → «+ Добавить почты» → вставить аккаунты строками.
- **Ключи доступа** → создать ключ сотруднику (показывается один раз).

## 7. Расширение сотруднику
Папка `extension/` → загрузить в Chrome (chrome://extensions → Режим разработчика →
Загрузить распакованное). В настройках расширения: адрес сервера + ключ. Добавить ящик —
вставить строку аккаунта целиком.

## Бэкап
Папка `server/data/` (Docker: том `mailviewer-data`) — там БД и `secret.key`. Бэкапить её.

## Чего в репозитории НЕТ (и не должно быть)
`.env`, `data/`, `secret.key`, `node_modules/` — в `.gitignore`. Секреты задаются только
на сервере.
