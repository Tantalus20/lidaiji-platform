/* 保存状态机自动测试（v0.2.6，纯 Node，零第三方依赖）。
 *
 * 覆盖：初始已保存；输入后 dirty；请求期间 saving；服务端确认后 saved；
 * 保存期间输入不得伪造“已保存”（saved 后回到 dirty）；
 * 失败后 failed、再输入回 dirty；重置回 saved；并发防护（重复 saving 不重复通知）。
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const { createSaveStateMachine } = await import(
  pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "studio", "app", "savestate.mjs")).href,
);

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`通过：${name}`);
  } catch (error) {
    failures += 1;
    console.error(`失败：${name}`);
    console.error(`  ${error.message}`);
  }
}

test("初始状态为已保存", () => {
  const m = createSaveStateMachine();
  assert.equal(m.status, "saved");
});

test("输入后变为有未保存修改", () => {
  const m = createSaveStateMachine();
  assert.equal(m.userInput(), "dirty");
  assert.equal(m.status, "dirty");
});

test("发起保存为 saving，确认后为 saved", () => {
  const m = createSaveStateMachine();
  m.userInput();
  assert.equal(m.saving(), "saving");
  assert.equal(m.saved(), "saved");
  assert.equal(m.status, "saved");
});

test("保存期间输入：saved 后回到 dirty，不得伪造已保存", () => {
  const m = createSaveStateMachine();
  m.userInput();
  m.saving();
  assert.equal(m.userInput(), "saving", "保存期间输入不改变 saving 状态");
  const next = m.saved();
  assert.equal(next, "dirty", "保存期间有输入，确认后必须是 dirty");
  assert.equal(m.status, "dirty");
});

test("失败后为 failed，再输入回 dirty", () => {
  const m = createSaveStateMachine();
  m.userInput();
  m.saving();
  assert.equal(m.failed(), "failed");
  assert.equal(m.status, "failed");
  assert.equal(m.userInput(), "dirty", "失败后再输入应回到未保存状态");
});

test("重新打开文章重置为已保存", () => {
  const m = createSaveStateMachine();
  m.userInput();
  m.saving();
  m.failed();
  m.reset();
  assert.equal(m.status, "saved");
});

test("并发写防护在调用方：机器层每次 saving() 开启新周期（回归：陈旧 dirtyDuringSave 污染）", () => {
  const m = createSaveStateMachine();
  m.userInput();
  m.saving();
  /* 保存期间输入 → dirtyDuringSave 置位（机器留在 saving） */
  m.userInput();
  /* 下一周期 saving() 必须清除陈旧标记，否则 saved() 会误判 dirty */
  m.saving();
  assert.equal(m.saved(), "saved", "新周期后 saved() 不得被上一周期污染");
  assert.equal(m.status, "saved");
});

test("变更通知顺序：dirty→saving→saved", () => {
  const m = createSaveStateMachine();
  const seen = [];
  m.onChange((status) => seen.push(status));
  m.userInput();
  m.saving();
  m.saved();
  assert.deepEqual(seen, ["dirty", "saving", "saved"]);
});

test("取消订阅后不再通知", () => {
  const m = createSaveStateMachine();
  let count = 0;
  const off = m.onChange(() => { count += 1; });
  m.userInput();
  off();
  m.saving();
  assert.equal(count, 1);
});

if (failures) {
  console.error(`保存状态机测试失败 ${failures} 项。`);
  process.exit(1);
}
console.log("保存状态机自动测试通过。");
