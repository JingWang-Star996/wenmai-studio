import assert from "node:assert/strict";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { WenmaiLauncherError, parseRunArguments, runVinext } from "../scripts/run-vinext.mjs";
test("维护锁优先拒绝启动",async()=>{const lock=join(process.cwd(),".wenmai-runtime-maintenance.lock");writeFileSync(lock,"fixture");try{await assert.rejects(()=>runVinext({argv:["dev"],platform:"linux"}),e=>e instanceof WenmaiLauncherError&&e.code==="MAINTENANCE_LOCK_ACTIVE");}finally{rmSync(lock,{force:true});}});
test("参数与本机端口保护仍存在",async()=>{assert.throws(()=>parseRunArguments(["build","--open"]),/只能用于/u);await assert.rejects(()=>runVinext({argv:["dev"],platform:"linux",probeImpl:async()=>({state:"occupied",reason:"foreign"})}),/不会结束或覆盖/u);});
test("未指定持久目录时真正移除继承的空状态变量",()=>{const text=readFileSync(new URL("../scripts/start-wenmai.ps1",import.meta.url),"utf8");assert.match(text,/Remove-Item Env:WENMAI_PERSIST_STATE_PATH/u);});
