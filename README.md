# agent-memory-minimal

Минимальный локальный MCP-сервер памяти для кодовых агентов (OpenCode, Claude Code и др.). Три тула, без демонов, портов и секретов — только MCP stdio, SQLite и локальные эмбеддинги.

- `memory_write` — записать один факт (title, content, tags `namespace:value`).
- `memory_search` — гибридный поиск (keyword FTS5 + векторный, мультиязычный).
- `memory_list` — последние записи, фильтр по тегам. Дешёвый вызов: модель не грузится.

Холодный вотчер — **~19MB приватной памяти** (WS ~52MB, остальное — shared). Воркер эмбеддингов живёт только на время запроса, пик — один на машину.

## Зачем

Полновесные мемори-серверы дают десятки тулов: захваты сессий, консолидации, replay, timeline, governance, вьюверы и движки на отдельных портах. Для рабочего воркспейса реально используются две операции:

- Startup sync — узкий recall правил, активных задач и решений (`Workspace_Global_Rules`, `Active_Tasks`, `Dataset_Decision_*`).
- Write — один ценный факт с префиксом проекта.

Лишние тулы — это токены в системном промпте на каждое сообщение, риск вызова не того поиска и поверхность поломок при апгрейде. Здесь тулсет зафиксирован тремя инструментами с жёстким контрактом: одна запись — один факт, теги строго `namespace:value`, решения — `Dataset_Decision_*` с полями SCOPE/RULE/SOURCES/RATIONALE/SUPERSEDES/DATE.

## Установка

Требования: Node 20+.

```bash
git clone https://github.com/ilgizar-valiullin/agent-memory-minimal.git
cd agent-memory-minimal
npm install
npm run build
npm run bootstrap   # разовый прогрев кэша модели (~152MB), дальше офлайн
```

## Подключение

OpenCode (`opencode.json`):

```json
{
  "mcp": {
    "minimal-memory": {
      "type": "local",
      "command": ["node", "--jitless", "--optimize-for-size", "--max-old-space-size=64", "D:/Projects/agent-memory-minimal/dist/watcher.js"],
      "enabled": true
    }
  }
}
```

Любой MCP-клиент с транспортом stdio: команда выше, рабочая директория не важна, все пути — через env/APPDATA.

Переменные окружения:

| Переменная | Дефолт | Назначение |
|---|---|---|
| `AGENT_MEMORY_DIR` | `%APPDATA%/agent-memory-minimal` (win), `~/Library/Application Support/...` (mac), `~/.local/share/...` (linux) | Корень данных |
| `AGENT_MEMORY_DB` | `<DIR>/memory.sqlite` | Файл БД |
| `AGENT_MEMORY_MODEL_CACHE` | `<DIR>/models` | Кэш модели |
| `AGENT_MEMORY_MODEL` | `Xenova/multilingual-e5-small` | Модель эмбеддингов |
| `AGENT_MEMORY_IDLE_TIMEOUT_MS` | `0` | 0 — убивать воркер сразу после использования; >0 — держать тёплым |
| `AGENT_MEMORY_HOT_IDLE_TIMEOUT_MS` | `0` | То же для hot-бэкенда |
| `AGENT_MEMORY_SLOT_TIMEOUT_MS` | `30000` | Ожидание межпроцессного слота эмбеддингов |

## Архитектура

Три процесса, каждый живёт только пока нужен:

```text
OpenCode (stdio, newline-JSON)
  |
  v
watcher.js — zero-dep фасад (~19MB private), ждёт команду.
  Отвечает сам: initialize / tools/list / ping.
  Первый tools/call поднимает hot.js и проксирует.
  |
  v
hot.js — вся логика (~60/45MB transient, 0 в простое):
  SQLite (WAL) + FTS5 + sqlite-vec vec0 + валидация + RRF-слияние.
  Умирает, когда нет активных вызовов.
  |
  v (только на время embed)
embed-worker.js — @xenova/transformers, e5-small, префиксы
  passage:/query:. ~740MB transient. Межпроцессный мьютекс
  (embed.lock, O_EXCL): пик — 1 воркер на машину.
```

Почему не Qdrant/Milvus/pgvector: им нужен Docker/Postgres/кластер. Для трёх тулов это лишний опс. SQLite-файл покрывает WAL-параллельность нескольких инстансов (проверено: 2 процесса × 30 конкурентных записей — 60/60, `integrity_check: ok`).

Почему `multilingual-e5-small` (384 dim, как и было): заметно лучше русской выборки, чем MiniLM (замерено A/B на живых запросах), английский не проседает. Цена — таблица эмбеддингов XLM-R (~250k токенов): ~740MB transient вместо ~176MB у MiniLM. При политике «убить сразу после использования» это только пик на время запроса.

## Замеры (Windows, NVMe)

- Холодный вотчер: WS 52MB / Private 19MB (bare node 53/20 — вотчер почти у пола).
- `tools/list`: ~110мс, ничего не спавнит.
- Холодный поиск: ~0.8–2.5с (подъём hot + воркера + инференс).
- 2 вотчера × одновременный холодный поиск: оба топ-1, пик воркеров 1, через 3с — 0 процессов.
- Параллельная запись: 60/60 без `SQLITE_BUSY` наружу.

## Миграция со старого бэкенда

```bash
# 1. Снять экспорт старого сервера в export.json (массив {title, content, tags})
node scripts/migrate.mjs export.json --dry-run
node scripts/migrate.mjs export.json
```

Скрипт переносит записи, валидирует контракт (пустые отбрасывает со счётчиком) и пишет через `memory_write`, чтобы вектора посчитались новой моделью.

## Разработка

```bash
npm run build        # tsc -> dist/
npm run test:stdio   # write -> search -> list через stdio
```

## Donations / Support the Project

* **EVM Address** (USDT, USDC, ETH, BNB): `0x3acf78e721aa065bd1509735a3ace630fcd0f452`

  _Supported networks: BNB Smart Chain (BEP20), Polygon, Arbitrum One, Ethereum (ERC20)_
  <details>
  <summary>Show EVM QR Code</summary>
  <img src=".github/images/evm.jpg" width="300" alt="EVM Deposit QR">
  </details>

* **USDT (TRC20)**: `TMG1BZJswd8UacHANKVi9Veq5FqSbaMjAQ`

  _Supported network: Tron (TRC20)_
  <details>
  <summary>Show TRC20 QR Code</summary>
  <img src=".github/images/trc20.jpg" width="300" alt="TRC20 Deposit QR">
  </details>

* **TON / USDT (TON)**: `UQDjf84AZSwuCPC3UWFv28p-V44zI-1lfhqCMfaex2Q-jDsY`

  _Supported network: The Open Network (TON)_
  <details>
  <summary>Show TON QR Code</summary>
  <img src=".github/images/ton.jpg" width="300" alt="TON Deposit QR">
  </details>

## License

MIT
