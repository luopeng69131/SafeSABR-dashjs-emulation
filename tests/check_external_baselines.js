'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const external = JSON.parse(
    fs.readFileSync(path.join(root, 'app/assets/external_baselines.json'), 'utf8')
);
const bitratesKbps = [3000, 8000, 15000, 30000, 60000, 120000];
const chunks = {
    chunks: Array.from(
        { length: 48 },
        () => bitratesKbps.map((bitrate) => bitrate * 1000 / 8 * 4)
    ),
};

global.performance = { now: () => 0 };
global.__SAFESABR_EXPERIMENT__ = { stalls: [] };
require(path.join(root, 'app/baseline_rules.js'));

function assert(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
}

function runtime(method, traceId, elapsedS) {
    const value = new global.BaselineAbrRuntime(
        { getBufferLength: () => 8 },
        chunks,
        method,
        { traceId, externalBaselines: external, startSecond: 0, seed: 42 }
    );
    value.elapsedSeconds = () => elapsedS;
    return value;
}

function request() {
    const started = new Date(0);
    return {
        trequest: started,
        tfinish: new Date(1000),
        bytesLoaded: 1_000_000,
        duration: 4,
        representation: { bitrateInKbit: 8000 },
    };
}

const starTrace = 'osn_recording_099_window_001.trace';
const star = runtime('starnet_mpc', starTrace, 30);
const starRows = external.predictors.starnet_mpc.traces[starTrace];
const starExpected = starRows.filter((row) => row[0] <= 30).slice(-1)[0];
assert(star.externalPredictionKbps().timeS === starExpected[0], 'StarNet lookup is not causal');
star.completeChunk(request(), 8);
assert(star.decisionLog[0].prediction_source === 'StarNet-point', 'StarNet source was not used');
assert(
    star.decisionLog[0].predicted_kbps === starExpected[1],
    'StarNet prediction differs from the packaged input'
);

const lumos = runtime('lumos_mpc', starTrace, 8.5);
const lumosRows = external.predictors.lumos_mpc.traces[starTrace];
const lumosExpected = lumosRows.filter((row) => row[0] <= 8.5).slice(-1)[0];
lumos.completeChunk(request(), 8);
assert(lumos.decisionLog[0].prediction_source === 'Lumos-DT', 'Lumos source was not used');
assert(
    lumos.decisionLog[0].prediction_time_s === lumosExpected[0],
    'Lumos lookup selected a future prediction'
);

const warmupTrace = 'vic_recording_130_window_000.trace';
const warmup = runtime('starnet_mpc', warmupTrace, 20);
warmup.completeChunk(request(), 8);
assert(
    warmup.decisionLog[0].prediction_source.includes('fallback_robust_history'),
    'StarNet warm-up did not use the declared causal fallback'
);

const wabb = runtime('wabb', starTrace, 10);
const weather = external.wabb.traces[starTrace];
wabb.completeChunk(request(), 8);
const targetKbps = Math.min(12 / weather.target_buffer_s, 1) * 120000;
assert(
    wabb.nextAction === wabb.actionForBitrate(targetKbps),
    'WABB bitrate does not match its weather-conditioned buffer target'
);
assert(wabb.decisionLog[0].weather_class === weather.weather_class, 'WABB weather is missing');

console.log(JSON.stringify({
    traces: Object.keys(external.wabb.traces).length,
    starnet_rows: Object.values(external.predictors.starnet_mpc.traces)
        .reduce((sum, rows) => sum + rows.length, 0),
    lumos_rows: Object.values(external.predictors.lumos_mpc.traces)
        .reduce((sum, rows) => sum + rows.length, 0),
    wabb_action: wabb.nextAction,
}));
