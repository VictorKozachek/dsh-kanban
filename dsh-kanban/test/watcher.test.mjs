/**
 * Тесты чистой части сторожа доски: разбор карточек и правила нарядов.
 *
 * Запуск: node dsh-kanban/test/watcher.test.mjs
 */
import assert from "node:assert/strict";
import { deliveryKey, parseCard, planNotices, snapshotCards, pickBoardRoot, isSessionId } from "../lib/watcher-core.js";

let failed = 0;
let passed = 0;

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`   ok: ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`   ПРОВАЛ: ${name}\n      ${error.message}`);
  }
}

function card(id, status, extra = {}) {
  const fields = [
    "---",
    `id: "${id}"`,
    `title: Задача ${id}`,
    `status: ${status}`,
    `owner: "${extra.owner ?? ""}"`,
    `role: "${extra.role ?? ""}"`,
    "---",
    "",
    "## Задача",
    "что-то"
  ];
  return fields.join("\n");
}

function snapshot(list) {
  return snapshotCards(list.map(([id, status, extra]) => [`${id}.md`, card(id, status, extra)]));
}

const ROLES = { reviewer: "session-8cce3644-b81e-4783-8ee2-04d8c0d0569e", verifier: "session-03d032c7-b73e-4ed5-82de-4cbb49138180", dispatcher: "session-858ea672-a0aa-45d3-87f8-ed09765debc9" };

console.log("== вложенные доски: корень сессии — самый глубокий");

await check("pickBoardRoot выбирает самый глубокий наблюдаемый корень", () => {
  const roots = ["/w/team", "/w/team/project", "/w/team/project/component"];
  assert.equal(pickBoardRoot(roots, "/w/team/project/component"), "/w/team/project/component");
  assert.equal(pickBoardRoot(roots, "/w/team/project/component/sub"), "/w/team/project/component");
  assert.equal(pickBoardRoot(roots, "/w/team/project/other"), "/w/team/project");
  assert.equal(pickBoardRoot(roots, "/w/team"), "/w/team");
  assert.equal(pickBoardRoot(roots, "/w/elsewhere"), null);
  // порядок корней не должен влиять: родитель раньше или позже — ответ один.
  assert.equal(pickBoardRoot([...roots].reverse(), "/w/team/project/component"), "/w/team/project/component");
});

await check("isSessionId пропускает id сессий и отсекает человекочитаемые метки", () => {
  assert.equal(isSessionId("session-9de97340-dfd7-46ba-9c14-7f8ff0722289"), true);
  assert.equal(isSessionId("9de97340-dfd7-46ba-9c14-7f8ff0722289"), true);
  assert.equal(isSessionId("executor-skills (DSH)"), false);
  assert.equal(isSessionId("sess-worker"), false);
  assert.equal(isSessionId(""), false);
  assert.equal(isSessionId(null), false);
});

console.log("== разбор карточек");
check("поля читаются, кавычки снимаются", () => {
  const parsed = parseCard(card("007", "in-progress", { owner: "session-6af8ff46-f3e7-4640-8a2d-045543fbc030" }));
  assert.equal(parsed.id, "007");
  assert.equal(parsed.status, "in-progress");
  assert.equal(parsed.owner, "session-6af8ff46-f3e7-4640-8a2d-045543fbc030");
  assert.equal(parsed.broken, false);
});
check("экранированные кавычки в owner снимаются", () => {
  const text = '---\nid: "001"\nstatus: todo\nowner: "a\\"b"\n---\n';
  assert.equal(parseCard(text).owner, 'a"b');
});
check("файл без front matter помечается сломанным", () => {
  assert.equal(parseCard("просто текст").broken, true);
});
check("карточка без id помечается сломанной", () => {
  assert.equal(parseCard('---\ntitle: Без id\nstatus: todo\n---\n').broken, true);
});
check("README и не-markdown в снимок не попадают", () => {
  const shot = snapshotCards([["README.md", "# Доска"], ["notes.txt", "x"], ["007.md", card("007", "todo")]]);
  assert.deepEqual([...shot.keys()], ["007"]);
});

check("updated читается: он отличает повторный заход в тот же статус", () => {
  const first = parseCard('---\nid: "007"\nstatus: in-review\nupdated: 2026-10-13T14:00:00Z\n---\n');
  assert.equal(first.updated, "2026-10-13T14:00:00Z");
});
check("ключ доставки различает версии карточки и совпадает для одной версии", () => {
  const first = parseCard('---\nid: "007"\nstatus: in-review\nupdated: 14:00\n---\n');
  const second = parseCard('---\nid: "007"\nstatus: in-review\nupdated: 15:00\n---\n');
  const sameAgain = parseCard('---\nid: "007"\nstatus: in-review\nupdated: 14:00\n---\n');
  assert.equal(deliveryKey(first, "in-review"), deliveryKey(sameAgain, "in-review"));
  assert.notEqual(deliveryKey(first, "in-review"), deliveryKey(second, "in-review"));
  assert.notEqual(deliveryKey(first, "in-review"), deliveryKey(first, "testing"));
});

console.log("== правила нарядов");
check("новая карточка в todo никого не будит", () => {
  assert.deepEqual(planNotices(new Map(), snapshot([["007", "todo"]]), ROLES), []);
});
check("карточку взяли из очереди — исполнитель сам знает, будить некого", () => {
  const notices = planNotices(
    snapshot([["007", "todo", { owner: "session-6af8ff46-f3e7-4640-8a2d-045543fbc030" }]]),
    snapshot([["007", "in-progress", { owner: "session-6af8ff46-f3e7-4640-8a2d-045543fbc030" }]]),
    ROLES
  );
  assert.deepEqual(notices, []);
});
check("уход на ревью будит ревьювера", () => {
  const notices = planNotices(
    snapshot([["007", "in-progress", { owner: "session-6af8ff46-f3e7-4640-8a2d-045543fbc030" }]]),
    snapshot([["007", "in-review", { owner: "session-6af8ff46-f3e7-4640-8a2d-045543fbc030" }]]),
    ROLES
  );
  assert.equal(notices.length, 1);
  assert.equal(notices[0].sessionId, "session-8cce3644-b81e-4783-8ee2-04d8c0d0569e");
  assert.equal(notices[0].kind, "review");
  assert.match(notices[0].text, /ждёт ревью/);
  assert.match(notices[0].text, /\.kanban\/tasks\/007\.md/);
});
check("ревьювер принял — будим тестировщика", () => {
  const notices = planNotices(
    snapshot([["007", "in-review", { owner: "session-6af8ff46-f3e7-4640-8a2d-045543fbc030" }]]),
    snapshot([["007", "testing", { owner: "session-6af8ff46-f3e7-4640-8a2d-045543fbc030" }]]),
    ROLES
  );
  assert.equal(notices.length, 1);
  assert.equal(notices[0].sessionId, "session-03d032c7-b73e-4ed5-82de-4cbb49138180");
  assert.equal(notices[0].kind, "test");
});
check("ревьювер вернул карточку — будим исполнителя", () => {
  const notices = planNotices(
    snapshot([["007", "in-review", { owner: "session-6af8ff46-f3e7-4640-8a2d-045543fbc030" }]]),
    snapshot([["007", "in-progress", { owner: "session-6af8ff46-f3e7-4640-8a2d-045543fbc030" }]]),
    ROLES
  );
  assert.equal(notices.length, 1);
  assert.equal(notices[0].sessionId, "session-6af8ff46-f3e7-4640-8a2d-045543fbc030");
  assert.equal(notices[0].kind, "returned");
  assert.match(notices[0].text, /вернулась в работу/);
});
check("возврат из blocked и из testing тоже будит исполнителя", () => {
  for (const from of ["blocked", "testing", "ready"]) {
    const notices = planNotices(
      snapshot([["007", from, { owner: "session-6af8ff46-f3e7-4640-8a2d-045543fbc030" }]]),
      snapshot([["007", "in-progress", { owner: "session-6af8ff46-f3e7-4640-8a2d-045543fbc030" }]]),
      ROLES
    );
    assert.equal(notices.length, 1, `из ${from}`);
    assert.equal(notices[0].sessionId, "session-6af8ff46-f3e7-4640-8a2d-045543fbc030", `из ${from}`);
  }
});
check("готово к слиянию — будим оркестратора", () => {
  const notices = planNotices(
    snapshot([["007", "testing", { owner: "session-6af8ff46-f3e7-4640-8a2d-045543fbc030" }]]),
    snapshot([["007", "ready", { owner: "session-6af8ff46-f3e7-4640-8a2d-045543fbc030" }]]),
    ROLES
  );
  assert.equal(notices.length, 1);
  assert.equal(notices[0].sessionId, "session-858ea672-a0aa-45d3-87f8-ed09765debc9");
  assert.match(notices[0].text, /task-commit\.sh 007/);
});
check("повторная запись того же статуса не спамит", () => {
  const before = snapshot([["007", "in-review", { owner: "session-6af8ff46-f3e7-4640-8a2d-045543fbc030" }]]);
  const after = snapshot([["007", "in-review", { owner: "session-6af8ff46-f3e7-4640-8a2d-045543fbc030" }]]);
  assert.deepEqual(planNotices(before, after, ROLES), []);
});
check("слияние никого не будит", () => {
  const notices = planNotices(
    snapshot([["007", "ready", { owner: "session-6af8ff46-f3e7-4640-8a2d-045543fbc030" }]]),
    snapshot([["007", "merged", { owner: "session-6af8ff46-f3e7-4640-8a2d-045543fbc030" }]]),
    ROLES
  );
  assert.deepEqual(notices, []);
});
check("без настроенных сессий ролей нарядов нет и падений нет", () => {
  const notices = planNotices(
    snapshot([["007", "in-progress", { owner: "session-6af8ff46-f3e7-4640-8a2d-045543fbc030" }]]),
    snapshot([["007", "in-review", { owner: "session-6af8ff46-f3e7-4640-8a2d-045543fbc030" }]]),
    {}
  );
  assert.deepEqual(notices, []);
});
check("карточка без владельца при возврате никого не будит", () => {
  const notices = planNotices(
    snapshot([["007", "in-review"]]),
    snapshot([["007", "in-progress"]]),
    ROLES
  );
  assert.deepEqual(notices, []);
});
check("ревьювер-владелец своей карточки не будится дважды", () => {
  const notices = planNotices(
    snapshot([["007", "in-progress", { owner: "session-8cce3644-b81e-4783-8ee2-04d8c0d0569e" }]]),
    snapshot([["007", "in-review", { owner: "session-8cce3644-b81e-4783-8ee2-04d8c0d0569e" }]]),
    ROLES
  );
  assert.deepEqual(notices, []);
});
check("несколько карточек — наряды по каждой", () => {
  const notices = planNotices(
    snapshot([["007", "in-progress", { owner: "session-6af8ff46-f3e7-4640-8a2d-045543fbc030" }], ["008", "in-progress", { owner: "session-6af8ff46-f3e7-4640-8a2d-045543fbc030" }]]),
    snapshot([["007", "in-review", { owner: "session-6af8ff46-f3e7-4640-8a2d-045543fbc030" }], ["008", "testing", { owner: "session-6af8ff46-f3e7-4640-8a2d-045543fbc030" }]]),
    ROLES
  );
  assert.deepEqual(
    notices.map((item) => [item.cardId, item.kind]),
    [["007", "review"], ["008", "test"]]
  );
});

check("наряд несёт статус карточки", () => {
  const notices = planNotices(
    snapshot([["007", "in-progress", { owner: "session-6af8ff46-f3e7-4640-8a2d-045543fbc030" }]]),
    snapshot([["007", "in-review", { owner: "session-6af8ff46-f3e7-4640-8a2d-045543fbc030" }]]),
    ROLES
  );
  assert.equal(notices[0].status, "in-review");
});
check("стартовый снимок: ждущие роль карточки дают наряды, остальные — нет", () => {
  const initial = snapshot([
    ["007", "in-review", { owner: "session-6af8ff46-f3e7-4640-8a2d-045543fbc030" }],
    ["008", "testing", { owner: "session-6af8ff46-f3e7-4640-8a2d-045543fbc030" }],
    ["009", "ready", { owner: "session-6af8ff46-f3e7-4640-8a2d-045543fbc030" }],
    ["010", "todo"],
    ["011", "in-progress", { owner: "session-6af8ff46-f3e7-4640-8a2d-045543fbc030" }],
    ["012", "merged"]
  ]);
  const notices = planNotices(new Map(), initial, ROLES);
  assert.deepEqual(
    notices.map((item) => [item.cardId, item.kind]),
    [["007", "review"], ["008", "test"], ["009", "merge"]]
  );
});

console.log(`\nвсего: ${passed} ok, ${failed} провал(ов)`);
if (failed > 0) process.exit(1);
