(function (root) {
    'use strict';

    const BITRATES_KBPS = [3000, 8000, 15000, 30000, 60000, 120000];
    const CHUNK_DURATION_S = 4;
    const REBUFFER_PENALTY = 40;
    const LINK_RTT_S = 0.08;
    const MPC_HORIZON = 5;

    function requestDurationMs(request) {
        if (request.trequest && request.tfinish) {
            return Math.max(request.tfinish.getTime() - request.trequest.getTime(), 1);
        }
        if (Array.isArray(request.traces)) {
            return Math.max(request.traces.reduce((sum, trace) => sum + Number(trace.d || 0), 0), 1);
        }
        return 1;
    }

    function harmonicMean(values) {
        const clean = values.filter((value) => Number.isFinite(value) && value > 0);
        if (!clean.length) {
            return NaN;
        }
        return clean.length / clean.reduce((sum, value) => sum + 1 / value, 0);
    }

    function buildCombinations(horizon) {
        const combinations = [];
        const count = BITRATES_KBPS.length ** horizon;
        for (let encoded = 0; encoded < count; encoded += 1) {
            const sequence = [];
            for (let position = 0; position < horizon; position += 1) {
                sequence.push(Math.floor(encoded / (BITRATES_KBPS.length ** position)) % BITRATES_KBPS.length);
            }
            combinations.push(sequence);
        }
        return combinations;
    }

    class RobustMpcPlanner {
        constructor(chunks, horizon = MPC_HORIZON) {
            this.chunks = chunks.chunks;
            this.horizon = horizon;
            this.combinations = buildCombinations(horizon);
        }

        choose(lastAction, predictedKbps, bufferSeconds, nextChunkIndex) {
            const futureLength = Math.min(this.horizon, this.chunks.length - nextChunkIndex);
            if (futureLength <= 0) {
                return lastAction;
            }
            const capacityBytesPerSecond = Math.max(predictedKbps, 1e-6) * 1000 / 8;
            let bestReward = -Infinity;
            let bestAction = lastAction;
            for (const sequence of this.combinations) {
                let buffer = Math.max(bufferSeconds, 0);
                let cumulativeRebuffer = 0;
                let totalReward = 0;
                let previous = lastAction;
                for (let offset = 0; offset < futureLength; offset += 1) {
                    const action = sequence[offset];
                    const sizeBytes = this.chunks[nextChunkIndex + offset][action];
                    const downloadSeconds = sizeBytes / capacityBytesPerSecond + LINK_RTT_S;
                    const stepRebuffer = Math.max(downloadSeconds - buffer, 0);
                    cumulativeRebuffer += stepRebuffer;
                    buffer = Math.max(buffer - downloadSeconds, 0) + CHUNK_DURATION_S;
                    totalReward += BITRATES_KBPS[action] / 1000 -
                        REBUFFER_PENALTY * cumulativeRebuffer -
                        Math.abs(BITRATES_KBPS[action] - BITRATES_KBPS[previous]) / 1000;
                    previous = action;
                }
                // Match the original RobustMPC implementation's last-tie-wins behavior.
                if (totalReward >= bestReward) {
                    bestReward = totalReward;
                    bestAction = sequence[0];
                }
            }
            return bestAction;
        }
    }

    class SeededRandom {
        constructor(seed) {
            this.state = (seed >>> 0) || 1;
            this.spare = null;
        }

        uniform() {
            this.state = (1664525 * this.state + 1013904223) >>> 0;
            return (this.state + 0.5) / 4294967296;
        }

        normal() {
            if (this.spare !== null) {
                const value = this.spare;
                this.spare = null;
                return value;
            }
            const radius = Math.sqrt(-2 * Math.log(Math.max(this.uniform(), 1e-12)));
            const angle = 2 * Math.PI * this.uniform();
            this.spare = radius * Math.sin(angle);
            return radius * Math.cos(angle);
        }
    }

    class BaselineAbrRuntime {
        constructor(player, chunks, method, options) {
            this.player = player;
            this.chunks = chunks;
            this.method = method;
            this.startSecond = Number(options.startSecond || 0);
            this.seed = Number(options.seed || 42);
            this.traceId = String(options.traceId || '');
            this.externalBaselines = options.externalBaselines || null;
            this.planner = new RobustMpcPlanner(chunks);
            this.lastAction = 1;
            this.nextAction = 1;
            this.completedChunks = 0;
            this.throughputHistory = [];
            this.pastErrors = [];
            this.pastBandwidthEstimates = [];
            this.policyDecisionMs = [];
            this.rescueDecisionMs = [];
            this.rescueDecisions = [];
            this.decisionLog = [];
            this.traceStartedAt = performance.now();
            this.lastStallTotal = 0;
            this.banditSlot = null;
            this.banditActions = [];
            this.banditRewards = [];
            this.banditThroughputs = [];
            this.pendingBanditThroughput = null;
            this.random = new SeededRandom(this.seed);
            this.validateExternalInputs();
        }

        bufferSeconds() {
            const value = this.player.getBufferLength('video');
            return Number.isFinite(value) ? value : 0;
        }

        elapsedSeconds() {
            return (performance.now() - this.traceStartedAt) / 1000;
        }

        actionForBitrate(bitrateKbps) {
            let best = 0;
            let distance = Infinity;
            BITRATES_KBPS.forEach((bitrate, index) => {
                const candidate = Math.abs(bitrate - Number(bitrateKbps));
                if (candidate < distance) {
                    best = index;
                    distance = candidate;
                }
            });
            return best;
        }

        validateExternalInputs() {
            if (!['starnet_mpc', 'lumos_mpc', 'wabb'].includes(this.method)) {
                return;
            }
            if (!this.externalBaselines || this.externalBaselines.schema !== 1) {
                throw new Error(`external baseline inputs are unavailable for ${this.method}`);
            }
            if (this.method === 'wabb') {
                const weather = this.externalBaselines.wabb &&
                    this.externalBaselines.wabb.traces[this.traceId];
                if (!weather) {
                    throw new Error(`WABB weather metadata is unavailable for ${this.traceId}`);
                }
                return;
            }
            const predictor = this.externalBaselines.predictors &&
                this.externalBaselines.predictors[this.method];
            if (!predictor || !predictor.traces[this.traceId]) {
                throw new Error(`${this.method} predictions are unavailable for ${this.traceId}`);
            }
        }

        externalPredictionKbps() {
            const predictor = this.externalBaselines && this.externalBaselines.predictors &&
                this.externalBaselines.predictors[this.method];
            const rows = predictor && predictor.traces[this.traceId];
            if (!Array.isArray(rows) || !rows.length) {
                return { kbps: NaN, source: 'missing_external_prediction', timeS: null };
            }
            const elapsed = this.elapsedSeconds();
            let low = 0;
            let high = rows.length;
            while (low < high) {
                const middle = Math.floor((low + high) / 2);
                if (Number(rows[middle][0]) <= elapsed) {
                    low = middle + 1;
                } else {
                    high = middle;
                }
            }
            if (low === 0) {
                return { kbps: NaN, source: 'external_prediction_warmup', timeS: null };
            }
            const row = rows[low - 1];
            return {
                kbps: Number(row[1]),
                source: predictor.predictor,
                timeS: Number(row[0]),
            };
        }

        wabbWeather() {
            return this.externalBaselines.wabb.traces[this.traceId];
        }

        robustCapacityKbps(measuredKbps) {
            let currentError = 0;
            if (this.pastBandwidthEstimates.length) {
                currentError = Math.abs(
                    this.pastBandwidthEstimates[this.pastBandwidthEstimates.length - 1] - measuredKbps
                ) / Math.max(measuredKbps, 1e-6);
            }
            this.pastErrors.push(currentError);
            this.throughputHistory.push(measuredKbps);
            const harmonic = harmonicMean(this.throughputHistory.slice(-5));
            const maximumError = Math.max(...this.pastErrors.slice(-5));
            this.pastBandwidthEstimates.push(harmonic);
            return harmonic / (1 + maximumError);
        }

        secondsToNextHandover() {
            const second = (this.startSecond + this.elapsedSeconds()) % 60;
            const deltas = [12, 27, 42, 57]
                .map((boundary) => (boundary - second + 60) % 60)
                .filter((delta) => delta > 1e-6);
            return deltas.length ? Math.min(...deltas) : 15;
        }

        handoverSlot() {
            return Math.floor((this.startSecond + this.elapsedSeconds() - 12) / 15);
        }

        resetBanditSlot(slot) {
            this.banditSlot = slot;
            this.banditActions = [];
            this.banditRewards = [];
            this.banditThroughputs = [];
            this.pendingBanditThroughput = null;
        }

        chooseCmab(measuredKbps, reward) {
            const slot = this.handoverSlot();
            if (slot !== this.banditSlot) {
                this.resetBanditSlot(slot);
            }
            if (this.pendingBanditThroughput !== null) {
                this.banditActions.push(this.lastAction);
                this.banditRewards.push(Math.max(reward / 120, -10));
                this.banditThroughputs.push(this.pendingBanditThroughput);
            }
            const measuredMbps = measuredKbps / 1000;
            let action = BITRATES_KBPS.length - 1;
            if (this.banditActions.length >= BITRATES_KBPS.length - 1) {
                const mean = this.banditThroughputs.reduce((sum, value) => sum + value, 0) /
                    this.banditThroughputs.length;
                const variance = this.banditThroughputs.reduce(
                    (sum, value) => sum + (value - mean) ** 2,
                    0
                ) / this.banditThroughputs.length;
                const scale = Math.sqrt(variance) || 1;
                const current = (measuredMbps - mean) / scale;
                let bestScore = -Infinity;
                for (let arm = 0; arm < BITRATES_KBPS.length; arm += 1) {
                    let a = 1;
                    let b = 0;
                    for (let index = 0; index < this.banditActions.length; index += 1) {
                        if (this.banditActions[index] !== arm) {
                            continue;
                        }
                        const feature = (this.banditThroughputs[index] - mean) / scale;
                        a += feature * feature;
                        b += feature * this.banditRewards[index];
                    }
                    const sampledTheta = b / a + 0.2 / Math.sqrt(a) * this.random.normal();
                    const score = current * sampledTheta;
                    if (score >= bestScore) {
                        bestScore = score;
                        action = arm;
                    }
                }
            }
            this.pendingBanditThroughput = measuredMbps;
            return action;
        }

        completeChunk(request, bufferSeconds) {
            const started = performance.now();
            const delayMs = requestDurationMs(request);
            const bytes = Number(request.bytesLoaded || request.bytesTotal || 0);
            const measuredKbps = bytes > 0 ? 8 * bytes / delayMs : 1;
            const action = this.actionForBitrate(
                request.representation ? request.representation.bitrateInKbit : BITRATES_KBPS[this.lastAction]
            );
            const stallTotal = root.__SAFESABR_EXPERIMENT__.stalls.reduce(
                (sum, stall) => sum + stall.duration_s,
                0
            );
            const incrementalStall = Math.max(stallTotal - this.lastStallTotal, 0);
            const reward = BITRATES_KBPS[action] / 1000 -
                REBUFFER_PENALTY * incrementalStall -
                Math.abs(BITRATES_KBPS[action] - BITRATES_KBPS[this.lastAction]) / 1000;
            this.lastStallTotal = stallTotal;
            this.lastAction = action;
            this.completedChunks += 1;
            // FRAGMENT_LOADING_COMPLETED fires before the downloaded segment is
            // appended to the media buffer. Plan from the post-append state.
            const planningBufferSeconds = Math.max(Number(bufferSeconds) || 0, 0) +
                Math.max(Number(request.duration) || CHUNK_DURATION_S, 0);

            let predictedKbps = measuredKbps;
            let predictionSource = 'measured';
            let predictionTimeS = null;
            let timeToHandover = null;
            let wabbWeather = null;
            if (this.method === 'cmab') {
                this.nextAction = this.chooseCmab(measuredKbps, reward);
            } else if (this.method === 'wabb') {
                wabbWeather = this.wabbWeather();
                const targetKbps = Math.max(
                    Math.min(planningBufferSeconds / wabbWeather.target_buffer_s, 1),
                    0
                ) * BITRATES_KBPS[BITRATES_KBPS.length - 1];
                this.nextAction = this.actionForBitrate(targetKbps);
                predictedKbps = null;
                predictionSource = 'weather_aware_buffer';
            } else {
                const robustKbps = this.robustCapacityKbps(measuredKbps);
                predictedKbps = robustKbps;
                predictionSource = 'robust_history';
                if (['starnet_mpc', 'lumos_mpc'].includes(this.method)) {
                    const external = this.externalPredictionKbps();
                    if (Number.isFinite(external.kbps) && external.kbps > 0) {
                        predictedKbps = external.kbps;
                        predictionSource = external.source;
                        predictionTimeS = external.timeS;
                    } else {
                        predictionSource = `${external.source}_fallback_robust_history`;
                    }
                }
                let planningBuffer = planningBufferSeconds;
                if (this.method === 'sara') {
                    timeToHandover = this.secondsToNextHandover();
                    if (timeToHandover <= 4) {
                        const targetBuffer = timeToHandover + 1 + 0.4;
                        const deficit = Math.max(targetBuffer - planningBufferSeconds, 0) /
                            Math.max(targetBuffer, 1e-6);
                        const scalar = Math.max(0.5, 1 - deficit);
                        planningBuffer *= scalar;
                        predictedKbps *= scalar;
                    }
                }
                this.nextAction = this.planner.choose(
                    this.lastAction,
                    predictedKbps,
                    planningBuffer,
                    Math.min(this.completedChunks, this.chunks.chunks.length - 1)
                );
            }
            const elapsedMs = performance.now() - started;
            this.policyDecisionMs.push(elapsedMs);
            this.decisionLog.push({
                chunk: this.completedChunks,
                measured_kbps: measuredKbps,
                predicted_kbps: predictedKbps,
                prediction_source: predictionSource,
                prediction_time_s: predictionTimeS,
                buffer_s: planningBufferSeconds,
                pre_append_buffer_s: bufferSeconds,
                selected_action: this.nextAction,
                time_to_handover_s: timeToHandover,
                weather_class: wabbWeather ? wabbWeather.weather_class : null,
                weather_target_buffer_s: wabbWeather ? wabbWeather.target_buffer_s : null,
                elapsed_ms: elapsedMs,
            });
        }

        decide() {
            return this.nextAction;
        }
    }

    function BaselineQualityRuleClass() {
        const context = this.context;
        const SwitchRequest = dashjs.FactoryMaker.getClassFactoryByName('SwitchRequest');

        function getSwitchRequest(rulesContext) {
            const switchRequest = SwitchRequest(context).create();
            const runtime = root.__ABR_RUNTIME__;
            if (!runtime || !rulesContext || rulesContext.getMediaType() !== 'video') {
                return switchRequest;
            }
            const action = runtime.decide();
            switchRequest.representation = rulesContext.getAbrController().getOptimalRepresentationForBitrate(
                rulesContext.getMediaInfo(),
                BITRATES_KBPS[action],
                true
            );
            switchRequest.priority = SwitchRequest.PRIORITY.STRONG;
            switchRequest.reason = { action, source: runtime.method };
            return switchRequest;
        }

        return { getSwitchRequest };
    }

    BaselineQualityRuleClass.__dashjs_factory_name = 'BaselineQualityRule';
    root.RobustMpcPlanner = RobustMpcPlanner;
    root.BaselineAbrRuntime = BaselineAbrRuntime;
    root.BaselineQualityRule = typeof dashjs === 'undefined'
        ? null
        : dashjs.FactoryMaker.getClassFactory(BaselineQualityRuleClass);
})(typeof window === 'undefined' ? globalThis : window);
