import assert from "node:assert/strict";
import test from "node:test";

import { conservativeInputTokenReservation } from "../app/meta-improvement-budget.ts";

test("输入预算预留按 UTF-8 字节保守覆盖中文与消息协议开销", () => {
  const ascii = conservativeInputTokenReservation([
    { role: "user", content: "test" },
  ]);
  const chinese = conservativeInputTokenReservation([
    { role: "user", content: "这是一个中文边界输入" },
  ]);

  assert.ok(ascii >= 128 + 32 + 4 + 4);
  assert.ok(chinese > ascii);
  assert.ok(chinese >= new TextEncoder().encode("这是一个中文边界输入").byteLength);
});

test("输入预算预留随消息数量和内容单调增加", () => {
  const one = conservativeInputTokenReservation([
    { role: "system", content: "fixed" },
  ]);
  const two = conservativeInputTokenReservation([
    { role: "system", content: "fixed" },
    { role: "user", content: "payload" },
  ]);
  const longer = conservativeInputTokenReservation([
    { role: "system", content: "fixed" },
    { role: "user", content: "payload with more bytes" },
  ]);

  assert.ok(two > one);
  assert.ok(longer > two);
});
