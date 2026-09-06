/**
 * `confirmationsFromEvents` reads the wait out of upstream's event log.
 *
 * The events are the 2026-09-05 BCH -> XMR swap's, verbatim from
 * `/json/bids/<id>`: the engine logged each retry of the XMR claim as
 * "Failed to publish lock tx B spend" while it waited for the Monero lock to
 * reach ten confirmations. Nothing had failed. The tracker showed a blank
 * "current step", the console said "Delaying", and the operator asked why the
 * swap had failed.
 */
import { describe, it, expect } from "vitest";
import { confirmationsFromEvents } from "../SidecarSwapTracker";

const LIVE_EVENTS = [
  { at: 1788621349, desc: "Lock tx B seen in chain" },
  { at: 1788621469, desc: "Lock tx B confirmed in chain" },
  { at: 1788622006, desc: "Lock tx A spend tx seen in chain" },
  { at: 1788622101, desc: "Failed to publish lock tx B spend: Chain B lock tx still confirming 6 / 10." },
  { at: 1788622311, desc: "Failed to publish lock tx B spend: Chain B lock tx still confirming 9 / 10." },
  { at: 1788622491, desc: "Delaying until: 2026-09-05 11:36:33" },
];

describe("confirmationsFromEvents", () => {
  it("reads the newest confirmation count out of the retry events", () => {
    expect(confirmationsFromEvents(LIVE_EVENTS)).toEqual({ have: 9, needed: 10 });
  });

  it("stops reporting once the spend is published", () => {
    const done = [...LIVE_EVENTS, { at: 1788622613, desc: "Lock tx B spend tx published" }];
    expect(confirmationsFromEvents(done)).toBeNull();
  });

  it("is null with no such event, and tolerates junk", () => {
    expect(confirmationsFromEvents(undefined)).toBeNull();
    expect(confirmationsFromEvents([])).toBeNull();
    expect(confirmationsFromEvents([null, 42, { desc: "Bid accepted" }] as unknown[])).toBeNull();
    expect(confirmationsFromEvents([{ event_msg: "still confirming 3 / 10" }])).toEqual({
      have: 3,
      needed: 10,
    });
  });
});
