const fs = require('fs');
const { performance } = require('perf_hooks');

globalThis.performance = performance;

if (process.argv.length !== 3) {
    throw new Error('usage: node check_stateful_runtime.js MODEL.json');
}

require('../app/baseline_rules.js');
require('../app/policy.js');
require('../app/flight_rescue_rule.js');

const model = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const bitrates = model.bitrate_ladder_kbps;
const chunkSizes = bitrates.map((bitrate) => bitrate * 1000 * 4 / 8);
const chunks = { chunks: Array.from({ length: 48 }, () => chunkSizes.slice()) };
const player = { getBufferLength: () => 12 };
const probeRuntime = new globalThis.SafeSabrRuntime(player, model, chunks, {
    executionMode: 'policy',
    probeChunk: 1,
    probeAction: 4,
});
probeRuntime.completedChunks = 1;
probeRuntime.decisionChunk = 0;
probeRuntime.policy.predict = () => ({ action: 5, logits: [] });
if (probeRuntime.decide(8) !== 4 ||
        !probeRuntime.decisionLog[0].probe_override ||
        probeRuntime.decisionLog[0].unforced_action !== 5) {
    throw new Error('causal action probe did not override exactly one policy request');
}
const fixedRuntime = new globalThis.SafeSabrRuntime(player, model, chunks, {
    executionMode: 'policy',
    fixedActionSequence: [4, 5],
});
fixedRuntime.policy.predict = () => ({ action: 0, logits: [] });
fixedRuntime.completedChunks = 1;
fixedRuntime.decisionChunk = 0;
if (fixedRuntime.decide(8) !== 5 ||
        fixedRuntime.decisionLog[0].model_action !== 0 ||
        !fixedRuntime.decisionLog[0].fixed_action_override) {
    throw new Error('fixed action sequence did not override the learned policy');
}
const lowCycleRuntime = new globalThis.SafeSabrRuntime(player, model, chunks, {
    executionMode: 'policy',
    fixedActionSequence: [0, 0, 1, 1, 2, 2, 3, 3, 2, 2, 1, 1],
});
lowCycleRuntime.policy.predict = () => ({ action: 5, logits: [] });
lowCycleRuntime.completedChunks = 6;
lowCycleRuntime.decisionChunk = 5;
if (lowCycleRuntime.decide(8) !== 3 ||
        !lowCycleRuntime.decisionLog[0].fixed_action_override) {
    throw new Error('low-bitrate probe cycle did not select the configured action');
}
const admissionRuntime = new globalThis.SafeSabrRuntime(player, model, chunks, {
    executionMode: 'admission',
    admissionBufferSeconds: 16,
});
admissionRuntime.transferThroughputHistoryKbps = [200000, 200000, 200000];
const admissionLowBufferAction = admissionRuntime.admissionProjectedAction(5, 12);
const admissionSafeAction = admissionRuntime.admissionProjectedAction(5, 20);
admissionRuntime.decisionLog.push({ chunk: 1, buffer_s: 20 });
admissionRuntime.observeRequestStart({ index: 1 }, 3);
const admissionErodedAction = admissionRuntime.admissionProjectedAction(5, 20);
if (admissionLowBufferAction !== 4 || admissionSafeAction !== 5 ||
        admissionErodedAction !== 4) {
    throw new Error('launch-aware admission did not enforce its buffer budget');
}
const unifiedRuntime = new globalThis.SafeSabrRuntime(player, model, chunks, {
    executionMode: 'unified',
});
unifiedRuntime.transferThroughputHistoryKbps = [200000, 200000, 200000];
const unifiedEntryEvidenceAction = unifiedRuntime.unifiedProjectedAction(5, 14);
const unifiedOpenAction = unifiedRuntime.unifiedProjectedAction(5, 14);
const unifiedRetainAction = unifiedRuntime.unifiedProjectedAction(5, 5);
const unifiedClosedAction = unifiedRuntime.unifiedProjectedAction(5, 1);
if (unifiedEntryEvidenceAction !== 4 || unifiedOpenAction !== 5 ||
        unifiedRetainAction !== 5 || unifiedClosedAction !== 4 ||
        unifiedRuntime.executionState !== 'unified_top_closed') {
    throw new Error('unified top-tier hysteresis did not preserve its entry and exit evidence');
}
const unifiedDipRuntime = new globalThis.SafeSabrRuntime(player, model, chunks, {
    executionMode: 'unified',
});
unifiedDipRuntime.executionState = 'unified_top_open';
unifiedDipRuntime.lastAction = 5;
unifiedDipRuntime.transferThroughputHistoryKbps = [200000, 200000, 200000];
const unifiedHeldDip = unifiedDipRuntime.unifiedProjectedAction(0, 14);
const unifiedConfirmedDip = unifiedDipRuntime.unifiedProjectedAction(0, 14);
if (unifiedHeldDip !== 5 || unifiedConfirmedDip !== 4) {
    throw new Error('unified policy stabilization did not debounce an isolated downward jump');
}
const dangerousRescue = globalThis.evaluateSafeSabrUnifiedRescue({
    currentAction: 5,
    previousAction: 5,
    capacityKbps: 20000,
    remainingBytes: 50_000_000,
    totalBytes: 60_000_000,
    replacementBytes: 30_000_000,
    usableBufferS: 5,
    bitrates,
});
const safeRescue = globalThis.evaluateSafeSabrUnifiedRescue({
    currentAction: 5,
    previousAction: 5,
    capacityKbps: 100000,
    remainingBytes: 50_000_000,
    totalBytes: 60_000_000,
    replacementBytes: 30_000_000,
    usableBufferS: 5,
    bitrates,
});
const lateRescue = globalThis.evaluateSafeSabrUnifiedRescue({
    currentAction: 5,
    previousAction: 5,
    capacityKbps: 10000,
    remainingBytes: 10_000_000,
    totalBytes: 60_000_000,
    replacementBytes: 30_000_000,
    usableBufferS: 1,
    bitrates,
});
if (!dangerousRescue.rescue || safeRescue.rescue || lateRescue.rescue) {
    throw new Error('unified in-flight rescue did not separate dangerous, safe, and late cases');
}
const runtime = new globalThis.SafeSabrRuntime(player, model, chunks, {
    executionMode: 'stateful',
    startSecond: 0,
});
if (!runtime.advisorPlanner) {
    throw new Error('MPC execution advisor is unavailable');
}
runtime.advisorAction = 5;

runtime.policy.predict = () => ({ action: 5, logits: [] });
runtime.transferThroughputHistoryKbps = [200000, 200000, 200000];
const startupAction = runtime.statefulProjectedAction(5, 6);
if (startupAction !== 3 || runtime.executionState !== 'startup_buffering') {
    throw new Error('startup reserve did not cap the initial policy request');
}

const gateRuntime = new globalThis.SafeSabrRuntime(player, model, chunks, {
    executionMode: 'stateful',
});
gateRuntime.executionState = 'capacity_envelope';
gateRuntime.envelopeCapAction = 3;
gateRuntime.advisorAction = 5;
gateRuntime.transferThroughputHistoryKbps = [100000, 100000, 100000];
const plannerAction = gateRuntime.statefulProjectedAction(5, 20);
const riskGatedAction = gateRuntime.statefulProjectedAction(5, 6);
if (plannerAction !== 5 || riskGatedAction !== 3 ||
        gateRuntime.riskGateCappedDecisions !== 1) {
    throw new Error('planner action and low-buffer risk gate are not separated');
}

const fastRuntime = new globalThis.SafeSabrRuntime(player, model, chunks, {
    executionMode: 'stateful',
});
fastRuntime.advisorAction = 5;
fastRuntime.completedChunks = 2;
fastRuntime.transferThroughputHistoryKbps = [80000, 220000];
const fastPathAction = fastRuntime.statefulProjectedAction(5, 8);
if (fastPathAction !== 5 || fastRuntime.executionState !== 'capacity_envelope') {
    throw new Error('strong startup evidence did not release the policy fast path');
}

runtime.updateEnvelopeAfterCompletion(16);
if (runtime.executionState !== 'capacity_envelope' || runtime.envelopeCapAction !== 4) {
    throw new Error('startup reserve did not open the measured capacity envelope');
}

runtime.transferThroughputHistoryKbps = [60000, 60000, 60000];
runtime.updateEnvelopeAfterCompletion(16);
if (runtime.envelopeCapAction !== 4 || runtime.lowerEvidence !== 1) {
    throw new Error('a single non-emergency sample lowered the envelope');
}
runtime.updateEnvelopeAfterCompletion(16);
if (runtime.envelopeCapAction !== 3) {
    throw new Error('sustained capacity loss did not lower the envelope');
}

runtime.transferThroughputHistoryKbps = [200000, 200000, 200000];
runtime.updateEnvelopeAfterCompletion(24);
if (runtime.envelopeCapAction !== 3) {
    throw new Error('envelope raised without enough continuous evidence');
}
runtime.updateEnvelopeAfterCompletion(24);
if (runtime.envelopeCapAction !== 4) {
    throw new Error('envelope did not raise one tier after continuous evidence');
}
runtime.updateEnvelopeAfterCompletion(24);
runtime.updateEnvelopeAfterCompletion(24);
if (runtime.envelopeCapAction !== 5) {
    throw new Error('top tier did not open with sufficient buffer and evidence');
}
runtime.transferThroughputHistoryKbps = [160000, 160000, 160000];
const lowBufferAction = runtime.statefulProjectedAction(5, 11.9);
if (lowBufferAction !== 4 || runtime.envelopeCapAction !== 4) {
    throw new Error('top tier did not close when the reserve fell below its exit threshold');
}

runtime.envelopeCapAction = 5;
runtime.transferThroughputHistoryKbps = [180000, 180000, 180000];
const strongCapacityAction = runtime.statefulProjectedAction(5, 8);
if (strongCapacityAction !== 5 || runtime.envelopeCapAction !== 5) {
    throw new Error('strong capacity evidence did not preserve the top tier');
}

runtime.lastAction = 5;
const heldPolicyDip = runtime.statefulProjectedAction(0, 5);
const confirmedPolicyDip = runtime.statefulProjectedAction(0, 5);
if (heldPolicyDip !== 5 || confirmedPolicyDip !== 4) {
    throw new Error('isolated policy downgrade was not debounced safely');
}

runtime.startSecond = 10;
runtime.traceStartedAt = performance.now();
runtime.envelopeCapAction = 5;
runtime.transferThroughputHistoryKbps = [160000, 160000, 160000];
const handoverAction = runtime.statefulProjectedAction(5, 20);
if (handoverAction !== 4 || runtime.handoverCappedDecisions !== 1) {
    throw new Error('handover guard did not lower a marginal top-tier request');
}

console.log(JSON.stringify({
    startup_action: startupAction,
    planner_action: plannerAction,
    risk_gated_action: riskGatedAction,
    fast_path_action: fastPathAction,
    low_buffer_action: lowBufferAction,
    strong_capacity_action: strongCapacityAction,
    handover_action: handoverAction,
    admission_low_buffer_action: admissionLowBufferAction,
    admission_safe_action: admissionSafeAction,
    admission_eroded_action: admissionErodedAction,
    unified_entry_evidence_action: unifiedEntryEvidenceAction,
    unified_open_action: unifiedOpenAction,
    unified_retain_action: unifiedRetainAction,
    unified_closed_action: unifiedClosedAction,
    unified_dangerous_rescue: dangerousRescue.rescue,
    unified_safe_rescue: safeRescue.rescue,
    unified_late_rescue: lateRescue.rescue,
    final_state: runtime.executionState,
    envelope_cap_action: runtime.envelopeCapAction,
}));
