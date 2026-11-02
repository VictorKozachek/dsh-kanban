# dsh-kanban

Канбан-доска агентских задач для [DeepSeek Harness](https://github.com/deepseek-ai) (DSH):
плагин в правом сайдбаре + файловый протокол задач + сторож, который сам рассылает
наряды агентским сессиям. Несколько ролей — оркестратор, исполнители, ревьювер,
тестировщик — работают по одной доске, не переписываясь в чате.

**A Kanban board for agent tasks inside DeepSeek Harness.** Task state lives in
`.kanban/tasks/*.md` in the project's git repository; the board reads the files,
and the plugin's host half watches them and dispatches work notices to agent
sessions, so several roles can work against one board.

![Доска / Board](dsh-kanban/docs/board-mockup-full-dark.png)

Полный фичалист — [FEATURES.ru.md](FEATURES.ru.md) (русский) и
[FEATURES.md](FEATURES.md) (English).

## Возможности · Features

- **Доска** в правом сайдбаре: 8 колонок (`backlog → todo → in-progress →
  in-review → testing → ready → merged` + `blocked`), панель деталей, токены по
  ролям, комментарии, значок «в ветке», тёмная и светлая темы.
- **Человек в цикле:** перетаскивание мышью только `backlog ↔ todo` с асайном
  самого свободного исполнителя (host-канал `kanbanCardActions`).
- **Сторож доски:** наряды в сессии по переходам карточек и асайну, дедупликация,
  повтор недоставленных, автоматический захват ролей по пресетам.
- **Изоляция на задачу:** каждая открытая задача живёт в своём git-worktree
  внутри проекта; карточка лежит в ветке задачи; слияние — `bin/task-commit.sh`.
- **Очередь и бэклог:** спецификации, `minTodo`, пул исполнителей
  (`.kanban/.workers.json`), выдача `bin/backlog-fill.sh` по слитому снимку доски.
- **Дочерние доски:** read-only обзор дерева досок команд (манифест
  `.kanban/children.json`, генератор `bin/board-children.sh`) — родитель видит
  прогресс дерева, но не управляет.
- **Восстановление пресета:** `bin/session-preset.sh` — офлайн-смена пресета
  существующей сессии (при закрытом DSH, с бэкапом и обновлением карты ролей;
  нужен перезапуск) — на случай, когда роль «слетела».
- **Совместимость:** DSH 0.2.1-rc.3, macOS bash 3.2, graceful shutdown Host'а;
  не зависит от внешних проектов-источников.

## Требования · Requirements

- DSH `0.2.1-rc.3` (desktop-приложение или `dsh web`) и macOS;
- `git` — рабочие деревья задач создаются через `git worktree`;
- `node` — для тестов и макетов (`bin/node.sh` находит его сам);
- `bash` 3.2+ (поставляется с macOS).

## Установка · Install

```bash
git clone https://github.com/VictorKozachek/dsh-kanban.git
cd dsh-kanban

# 1. плагин в профиль: web — штатно, desktop — тем же скриптом вручную
bin/install-kanban.sh            # профиль web
bin/install-kanban.sh desktop    # Electron-приложение

# 2. пресеты ролей (dispatcher / worker / reviewer / verifier)
bin/install-presets.sh

# 3. перезапустить DSH (профиль читает бандлы при старте)
```

После рестарта: правый сайдбар → «+» → «Канбан».

**Пути к проектам.** `dsh-kanban/cordis.patch.yml` — патч-слой бандла: там
настраиваются `boards` (проекты с доской) и `roots` (деревья, по которым сторож
сам находит доски рабочих пространств). По умолчанию пути вычисляются от
`$HOME` (`~/projects/...`) — поправьте под свою машину.

## Быстрый старт · Quick start

```bash
# в основном чекауте проекта — сессия с пресетом dispatcher
bin/task-new.sh "Починить экспорт QR"       # worktrees/007 + ветка task/007 + карточка
bin/board-status.sh                          # дамп доски

# задача → исполнителю (сессия в worktrees/007 с пресетом worker)
bin/task-move.sh 007 todo --owner "<session-id>"
# исполнитель: in-progress → in-review, затем ревью и тесты
# оркестратор: bin/task-commit.sh 007 — merge --no-ff + merged + уборка worktree
```

Подробный сценарий ролей, бэклог, асайн из GUI и лимиты — в
[KANBAN.md](KANBAN.md) и [AGENTS.md](AGENTS.md) (протокол агентов).

## Восстановление пресета · Preset recovery

Сменить пресет уже стартовавшей сессии DSH нельзя: реестр пресетов отвечает
`agent-preset/locked`, в интерфейсе выбор есть только при создании сессии. Если
роль «слетела», при **закрытом** DSH:

```bash
bin/session-preset.sh --list                          # сессии, cwd, текущий пресет
bin/session-preset.sh --session <id|prefix> --to worker --yes
# затем перезапустите DSH
```

Инструмент досыпает в лог сессии (`session.v4.jsonl.zstd`) один zstd-кадр с
событием `agent-preset/selected`, делает бэкап лога в
`~/.dsh/session-backups/` и обновляет карту ролей доски
(`.kanban/.watcher-roles.json`). Живой DSH он не трогает: если процесс держит
`flock` на `session.lock`, будет отказ. Для восстановления после потери
**определений** пресетов (issue #1) достаточно обновить плагин — определения
едут вместе с ним; подробности и ограничения — в [KANBAN.md](KANBAN.md).

## Структура репозитория · Layout

| Путь | Что это |
|---|---|
| `dsh-kanban/` | плагин: `lib/client.js` (GUI), `lib/index.js` (host-сторож), `lib/watcher-core.js`, `lib/backlog-notices.js`, `lib/card-actions.js`, `lib/children.js` |
| `bin/` | 21 скрипт протокола и установки (`task-*`, `board-*`, `spec-new`, `session-preset.*`, `install-*`, `test.sh`, `host-shutdown-check.mjs`) |
| `.kanban/` | `board.json` (`minTodo`), `tasks/README.md` (формат карточки); карточки и спеки в публичный снапшот не входят |
| `agent-presets/`, `presets/` | заготовки пресетов ролей и сгенерированные строки для профиля |
| `.agents/skills/` | скилы DSH `kanban` и `commit` |
| `test/`, `dsh-kanban/test/` | регрессии: 13 файлов, 457 проверок |
| `KANBAN.md`, `FEATURES*.md`, `AGENTS.md` | руководство, фичалист (ru/en), протокол агентов |

## Проверки · Tests

```bash
bin/test.sh                                   # весь набор: 457 проверок, должен быть зелёным
bin/node.sh bin/host-shutdown-check.mjs       # реальный graceful shutdown Host'а (4 сценария)
```

`bin/test.sh` не требует сети и работает из чистого клона: логика доски, рендер
без браузера, слияние worktree-копий, наряды, канал асайна, дочерние доски,
dispose/shutdown, скрипты и локали.

## Заметки · Notes

- **Публичный снапшот:** карточки задач и спецификации — локальная рабочая
  история; в репозиторий они не входят. Формат карточки и протокол описаны в
  `.kanban/tasks/README.md`, `AGENTS.md` и `KANBAN.md`, так что проект
  воспроизводим с нуля.
- Пуш в remote — операция человека, скрипты набора не пушат.
- DSH-обновления иногда требуют перегенерировать пресеты ролей:
  `bin/gen-role-presets.sh && bin/install-presets.sh` (см. KANBAN.md).

## Лицензия · License

[MIT](LICENSE).
