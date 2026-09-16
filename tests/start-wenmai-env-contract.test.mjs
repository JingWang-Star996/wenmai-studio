import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
const text=await readFile(new URL("../scripts/start-wenmai.ps1",import.meta.url),"utf8");
test("启动器保留本机认证环境与维护锁拒绝",()=>{assert.match(text,/WENMAI_RELEASE_CONTROL_V2_ENABLED/u);assert.match(text,/WENMAI_PUBLISH_OPERATOR_HOST_ROUTE_VERIFIED/u);assert.match(text,/wenmai-runtime-maintenance\.lock/u);assert.match(text,/WENMAI_PERSIST_STATE_PATH/u);assert.doesNotMatch(text,/Supervisor|DispatchReceipt|build-runtime/u);});
