import { test } from "node:test";
import assert from "node:assert/strict";
import { validateScheduleIntent } from "../src/schedule-validation.js";
import type { AgentIntent } from "@4evergent/shared";

// A real 56-char StrKey ed25519 public key (checksum-valid).
const VALID_ISSUER = "GDI73WJ4SX7LOG3XZDJC3KCK6ED6E5NBYK2JUBQSPBCNNWEG3ZN7T75U";
const VALID_DESTINATION = "GB3KJPLFUYN5VL6R3GU3EGCGVCKFDSD7BEDX42HWG5BWFKB3KQGJJRMA";

function makeIntent(over: Partial<AgentIntent> = {}): AgentIntent {
  return {
    type: "payment",
    asset: "XLM",
    destination: VALID_DESTINATION,
    amount: "10",
    reason: "test schedule",
    ...over,
  } as AgentIntent;
}

test("validateScheduleIntent: XLM schedule without assetDetails is valid", () => {
  const r = validateScheduleIntent(makeIntent());
  assert.equal(r.valid, true);
});

test("validateScheduleIntent: non-XLM schedule without assetDetails is rejected naming the missing issuer", () => {
  const r = validateScheduleIntent(makeIntent({ asset: "USDC" }));
  assert.equal(r.valid, false);
  assert.match(r.error!, /issuer/i);
});

test("validateScheduleIntent: BTC schedule without assetDetails is rejected naming the missing issuer", () => {
  const r = validateScheduleIntent(makeIntent({ asset: "BTC" }));
  assert.equal(r.valid, false);
  assert.match(r.error!, /issuer/i);
});

test("validateScheduleIntent: non-XLM schedule with assetDetails but null issuer is rejected", () => {
  const r = validateScheduleIntent(
    makeIntent({ asset: "USDC", assetDetails: { code: "USDC", issuer: null } })
  );
  assert.equal(r.valid, false);
  assert.match(r.error!, /issuer/i);
});

test("validateScheduleIntent: non-XLM schedule with a valid issuer is accepted", () => {
  const r = validateScheduleIntent(
    makeIntent({ asset: "USDC", assetDetails: { code: "USDC", issuer: VALID_ISSUER } })
  );
  assert.equal(r.valid, true);
});

test("validateScheduleIntent: non-payment intent is rejected", () => {
  const r = validateScheduleIntent({
    type: "trustline",
    assetCode: "USDC",
    issuer: VALID_ISSUER,
    reason: "test",
  } as AgentIntent);
  assert.equal(r.valid, false);
  assert.match(r.error!, /unsupported intent type/);
});
