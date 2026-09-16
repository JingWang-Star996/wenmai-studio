import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";

const route = await readFile(new URL("../app/api/release-control/v2/host/route.ts", import.meta.url), "utf8");
const auth = await readFile(new URL("../app/release-control-v2-host-auth.ts", import.meta.url), "utf8");

test("host endpoint is server-only, signed, and disabled unless both host gates are exact true", () => {
  assert.match(auth, /WENMAI_RELEASE_CONTROL_V2_ENABLED/);
  assert.match(auth, /WENMAI_PUBLISH_OPERATOR_HOST_ROUTE_VERIFIED/);
  assert.match(auth, /BROWSER_OR_SESSION_AUTH_FORBIDDEN/);
  assert.match(auth, /HOST_BODY_DIGEST_MISMATCH/);
  assert.match(auth, /MAX_SKEW_MS = 60_000/);
  assert.match(auth, /hostCanonicalRequest\(request\.method/);
});

test("one-time consumption stores only a lease-token digest and proves D1 CAS", () => {
  assert.match(route, /lease_token_sha256/);
  assert.match(route, /sha256ExecutionText\(leaseToken\)/);
  assert.match(route, /status = 'issued'/);
  assert.match(route, /CAPABILITY_CONSUMPTION_NOT_PROVEN/);
  assert.match(route, /capability_consumed/);
  assert.match(route, /article_publish_confirmation_items/);
  assert.match(route, /confirmation\.contract_sha256 !== packet\.contract\.sha256/);
  assert.doesNotMatch(route, /lease_token\s+TEXT/i);
});

test("receipt head conflict, unknown freeze, and probe-only readback stay fail-closed", () => {
  assert.match(route, /validateExecutionReceiptEvent\(event, current\)/);
  assert.match(route, /RECEIPT_HEAD_OR_BINDING_INVALID/);
  assert.match(route, /result_unknown/);
  assert.match(route, /status='frozen'/);
  assert.match(route, /READBACK_REQUIRES_FROZEN_LEASE/);
  assert.match(route, /'read_only_probe','inconclusive'/);
  assert.match(route, /lifecyclePromotion: false/);
});

test("host HMAC verifier executes with a valid signature and rejects browser credentials", () => {
  const authUrl = new URL("../app/release-control-v2-host-auth.ts", import.meta.url).href;
  const contractUrl = new URL("../app/release-execution-contract.ts", import.meta.url).href;
  const program = `import { signHostRequest, verifyHostRequest } from ${JSON.stringify(authUrl)}; import { sha256ExecutionText } from ${JSON.stringify(contractUrl)}; const raw='{}', secret='x'.repeat(32), timestamp=new Date().toISOString(), nonce='n'.repeat(32), bodySha256=await sha256ExecutionText(raw), host='host.local'; const signature=await signHostRequest({method:'POST',pathname:'/api/release-control/v2/host',host,timestamp,nonce,bodySha256},secret); const headers={'host':host,'x-wenmai-host-timestamp':timestamp,'x-wenmai-host-nonce':nonce,'x-wenmai-host-body-sha256':bodySha256,'x-wenmai-host-signature':signature}; await verifyHostRequest(new Request('https://host.local/api/release-control/v2/host',{method:'POST',headers,body:raw}),raw,secret); try { await verifyHostRequest(new Request('https://host.local/api/release-control/v2/host',{method:'POST',headers:{...headers,cookie:'x'},body:raw}),raw,secret); process.exit(2); } catch (error) { if (error.code !== 'BROWSER_OR_SESSION_AUTH_FORBIDDEN') process.exit(3); }`;
  assert.doesNotThrow(() => execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", program], { stdio: "pipe" }));
});
