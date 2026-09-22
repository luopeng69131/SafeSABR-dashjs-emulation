(function (root) {
    'use strict';

    const SERVICE_MARGIN = 0.9;
    const SERVICE_HISTORY = 5;
    const SERVICE_QUANTILE = 0.25;
    const MAX_VALID_TRANSFER_KBPS = 600000;
    const ENVELOPE_DOWNLOAD_TARGET_S = 3.5;
    const STARTUP_RESERVE_BUFFER_S = 16;
    const STARTUP_CAP_ACTION = 3;
    const ENVELOPE_RAISE_EVIDENCE = 2;
    const ENVELOPE_LOWER_EVIDENCE = 2;
    const ENVELOPE_EMERGENCY_BUFFER_S = 4;
    const POLICY_LOWER_EVIDENCE = 2;
    const POLICY_EMERGENCY_BUFFER_S = 2;
    const TOP_ENTER_BUFFER_S = 24;
    const TOP_EXIT_BUFFER_S = 12;
    const STRONG_TOP_CAPACITY_KBPS = 150000;
    const STARTUP_FAST_PATH_CAPACITY_KBPS = 180000;
    const STARTUP_FAST_PATH_MIN_CHUNKS = 2;
    const RECOVERY_TRIGGER_REBUFFER_S = 2;
    const HANDOVER_GUARD_WINDOW_S = 4;
    const HANDOVER_TOP_CAPACITY_KBPS = 180000;
    const HANDOVER_SECONDS = [12, 27, 42, 57];
    const TOP_ACTION = 5;
    const ADMISSION_FALLBACK_ACTION = 4;
    const ADMISSION_BUFFER_GUARD_S = 1;
    const ADMISSION_MIN_HISTORY = 2;
    const UNIFIED_TOP_ENTER_BUFFER_S = 12;
    const UNIFIED_TOP_EXIT_BUFFER_S = 4;
    const UNIFIED_EMERGENCY_BUFFER_S = 1.5;
    const UNIFIED_HARD_DEADLINE_MISS_S = 1;
    const UNIFIED_ENTRY_EVIDENCE = 2;
    const UNIFIED_EXIT_EVIDENCE = 2;
    const UNIFIED_COOLDOWN_CHUNKS = 2;
    const UNIFIED_POLICY_LOWER_EVIDENCE = 2;
    const REBUFFER_PENALTY = 40;
    const ORACLE_LAUNCH_GUARD_S = 0.25;
    const SELECTIVE_EXTREME_OVERRUN_S = 8;

    function dense(input, weight, bias, outSize, activation) {
        const inSize = input.length;
        const output = new Array(outSize);
        for (let row = 0; row < outSize; row += 1) {
            let value = bias[row];
            const offset = row * inSize;
            for (let col = 0; col < inSize; col += 1) {
                value += weight[offset + col] * input[col];
            }
            output[row] = activation === 'tanh' ? Math.tanh(value) : value;
        }
        return output;
    }

    class SafeSabrPolicy {
        constructor(model) {
            this.model = model;
            if (model.observation_size !== 25 || model.action_size !== 6) {
                throw new Error('unexpected SafeSABR model dimensions');
            }
        }

        logits(observation) {
            if (!Array.isArray(observation) || observation.length !== 25) {
                throw new Error('SafeSABR observation must contain 25 values');
            }
            let hidden = dense(
                observation,
                this.model.layers[0].weight,
                this.model.layers[0].bias,
                this.model.layers[0].out_features,
                'tanh'
            );
            hidden = dense(
                hidden,
                this.model.layers[1].weight,
                this.model.layers[1].bias,
                this.model.layers[1].out_features,
                'tanh'
            );
            return dense(
                hidden,
                this.model.action_head.weight,
                this.model.action_head.bias,
                this.model.action_size,
                null
            );
        }

        predict(observation) {
            const logits = this.logits(observation);
            let action = 0;
            for (let index = 1; index < logits.length; index += 1) {
                if (logits[index] > logits[action]) {
                    action = index;
                }
            }
            return { action, logits };
        }
    }

    class SafeSabrRuntime {
        constructor(player, model, chunks, options = {}) {
            this.player = player;
            this.policy = new SafeSabrPolicy(model);
            this.chunks = chunks;
            this.bitrates = model.bitrate_ladder_kbps.slice();
            this.totalChunks = chunks.chunks.length;
            this.lastAction = 1;
            this.completedChunks = 0;
            this.throughputFeatures = new Array(8).fill(0);
            this.delayFeatures = new Array(8).fill(0);
            this.nextSizes = this.getChunkSizes(0);
            this.remainingChunks = this.totalChunks;
            this.nextAction = 1;
            this.sessionRebufferSeconds = 0;
            this.policyDecisionMs = [];
            this.rescueDecisionMs = [];
            this.rescueDecisions = [];
            this.rescueDebug = [];
            this.decisionLog = [];
            this.decisionChunk = 0;
            this.pendingRescue = null;
            this.recoveryEpisodes = 0;
            this.recoveryCappedDecisions = 0;
            this.preflightCappedDecisions = 0;
            this.handoverCappedDecisions = 0;
            this.riskGateCappedDecisions = 0;
            this.oracleTrace = null;
            this.oracleLaunchProjection = false;
            this.oracleValueProjection = false;
            this.riskCritic = options.riskCritic || null;
            this.riskThreshold = Number.isFinite(Number(options.riskThreshold))
                ? Number(options.riskThreshold)
                : Number(this.riskCritic && this.riskCritic.threshold);
            this.serviceThroughputHistoryMbps = [];
            this.priorDecisionBufferSeconds = NaN;
            this.selectiveRiskScore = NaN;
            this.selectiveReason = 'not_evaluated';
            this.selectiveCappedDecisions = 0;
            this.traceStartedAt = null;
            this.startSecond = Number(options.startSecond || 0);
            this.executionMode = options.executionMode || 'policy';
            this.probeChunk = Number(options.probeChunk);
            this.probeAction = Number(options.probeAction);
            this.probeRescueChunk = Number(options.probeRescueChunk);
            this.probeRescueAction = Number(options.probeRescueAction);
            this.probeRescueAfterMs = Number(options.probeRescueAfterMs || 500);
            this.fixedActionSequence = Array.isArray(options.fixedActionSequence)
                ? options.fixedActionSequence.map(Number)
                : null;
            this.executionState = this.executionMode === 'stateful'
                ? 'startup_buffering'
                : this.executionMode === 'unified' ? 'unified_top_closed' : 'policy';
            this.transferThroughputHistoryKbps = [];
            this.advisorPlanner = typeof root.RobustMpcPlanner === 'function'
                ? new root.RobustMpcPlanner(chunks)
                : null;
            this.advisorThroughputHistoryKbps = [];
            this.advisorPastErrors = [];
            this.advisorPastEstimatesKbps = [];
            this.advisorCapacityKbps = NaN;
            this.advisorAction = this.nextAction;
            this.envelopeCapAction = STARTUP_CAP_ACTION;
            this.raiseEvidence = 0;
            this.lowerEvidence = 0;
            this.policyLowerEvidence = 0;
            this.lastStabilizedPolicyAction = this.nextAction;
            this.lastObservedRebufferSeconds = 0;
            this.admissionBufferSeconds = Number(options.admissionBufferSeconds || 16);
            this.launchErosionHistorySeconds = [];
            this.launchedChunks = new Set();
            this.unifiedTopFeasibleEvidence = 0;
            this.unifiedTopInfeasibleEvidence = 0;
            this.unifiedCooldownChunks = 0;
            this.unifiedPolicyLowerEvidence = 0;
            this.unifiedStateChanges = [];
        }

        actionForBitrate(bitrateKbps) {
            let best = 0;
            let distance = Infinity;
            this.bitrates.forEach((bitrate, index) => {
                const candidate = Math.abs(bitrate - Number(bitrateKbps));
                if (candidate < distance) {
                    best = index;
                    distance = candidate;
                }
            });
            return best;
        }

        getChunkSizes(index) {
            const safeIndex = Math.max(0, Math.min(Number(index), this.totalChunks - 1));
            const values = this.chunks.chunks[safeIndex];
            return values ? values.slice() : new Array(6).fill(0);
        }

        observation(bufferSeconds) {
            const nextSizes = this.nextSizes.map((bytes) => bytes / 1000 / 1000 / 10);
            return [
                this.bitrates[this.lastAction] / Math.max(...this.bitrates),
                Math.max(Number(bufferSeconds) || 0, 0) / 10,
                ...this.throughputFeatures,
                ...this.delayFeatures,
                ...nextSizes,
                Math.min(this.remainingChunks, 48) / 48,
            ];
        }

        decide(bufferSeconds) {
            if (this.pendingRescue !== null) {
                return this.pendingRescue.action;
            }
            if (this.decisionChunk === this.completedChunks) {
                return this.nextAction;
            }
            const started = performance.now();
            const observation = this.observation(bufferSeconds);
            const prediction = this.policy.predict(observation);
            const elapsedMs = performance.now() - started;
            this.policyDecisionMs.push(elapsedMs);
            const fixedAction = this.fixedActionSequence && this.fixedActionSequence.length
                ? this.fixedActionSequence[
                    this.completedChunks % this.fixedActionSequence.length
                ]
                : null;
            const requestedAction = Number.isInteger(fixedAction) && fixedAction >= 0 &&
                fixedAction < this.bitrates.length
                ? fixedAction
                : prediction.action;
            this.lastStabilizedPolicyAction = requestedAction;
            if (this.oracleValueProjection && this.completedChunks > 0) {
                this.nextAction = this.oracleValueProjectedAction(requestedAction, bufferSeconds);
            } else if (this.oracleLaunchProjection && this.completedChunks > 0) {
                this.nextAction = this.oracleProjectedAction(requestedAction, bufferSeconds);
            } else if (this.executionMode === 'selective' && this.completedChunks > 0) {
                this.nextAction = this.selectiveProjectedAction(requestedAction, bufferSeconds);
            } else if (this.executionMode === 'unified' && this.completedChunks > 0) {
                this.nextAction = this.unifiedProjectedAction(requestedAction, bufferSeconds);
            } else if (this.executionMode === 'admission' && this.completedChunks > 0) {
                this.nextAction = this.admissionProjectedAction(requestedAction, bufferSeconds);
            } else if (this.executionMode === 'stateful' && this.completedChunks > 0) {
                this.nextAction = this.statefulProjectedAction(requestedAction, bufferSeconds);
            } else {
                this.nextAction = requestedAction;
            }
            const unforcedAction = this.nextAction;
            const probeOverride = this.executionMode === 'policy' &&
                Number.isInteger(this.probeChunk) && Number.isInteger(this.probeAction) &&
                this.completedChunks === this.probeChunk && this.probeAction >= 0 &&
                this.probeAction < this.bitrates.length;
            if (probeOverride) {
                this.nextAction = this.probeAction;
            }
            this.decisionChunk = this.completedChunks;
            this.decisionLog.push({
                chunk: this.completedChunks,
                at_ms: performance.now() - Number(
                    root.__SAFESABR_EXPERIMENT__ &&
                    root.__SAFESABR_EXPERIMENT__.clock_origin_ms || performance.now()
                ),
                media_time_s: this.player && typeof this.player.time === 'function'
                    ? this.player.time()
                    : null,
                buffer_s: bufferSeconds,
                cumulative_rebuffer_s: this.sessionRebufferSeconds,
                requested_action: requestedAction,
                model_action: prediction.action,
                fixed_action_override: fixedAction !== null,
                selected_action: this.nextAction,
                unforced_action: unforcedAction,
                probe_override: probeOverride,
                previous_action: this.lastAction,
                next_chunk_sizes_bytes: this.nextSizes.slice(),
                transfer_throughput_history_kbps: this.transferThroughputHistoryKbps.slice(),
                execution_state: this.executionState,
                envelope_cap_action: this.envelopeCapAction,
                raise_evidence: this.raiseEvidence,
                lower_evidence: this.lowerEvidence,
                stabilized_policy_action: this.lastStabilizedPolicyAction,
                advisor_action: this.advisorAction,
                advisor_capacity_kbps: this.advisorCapacityKbps,
                risk_gate_capped_decisions: this.riskGateCappedDecisions,
                safe_transfer_capacity_kbps: this.safeTransferCapacityKbps(),
                latest_transfer_capacity_kbps: this.latestTransferCapacityKbps(),
                unified_top_feasible_evidence: this.unifiedTopFeasibleEvidence,
                unified_top_infeasible_evidence: this.unifiedTopInfeasibleEvidence,
                unified_cooldown_chunks: this.unifiedCooldownChunks,
                seconds_to_handover: this.secondsToNextHandover(),
                selective_risk_score: this.selectiveRiskScore,
                selective_reason: this.selectiveReason,
                selective_capped_decisions: this.selectiveCappedDecisions,
                elapsed_ms: elapsedMs,
            });
            this.priorDecisionBufferSeconds = Math.max(Number(bufferSeconds) || 0, 0);
            return this.nextAction;
        }

        completeChunk(request, bufferSeconds) {
            const bitrate = request.representation && request.representation.bitrateInKbit;
            const action = this.actionForBitrate(bitrate || this.bitrates[this.lastAction]);
            const delayMs = this.requestDurationMs(request);
            const bytes = Number(request.bytesLoaded || request.bytesTotal || 0);
            const transferThroughputKbps = delayMs > 0 ? (bytes * 8) / delayMs : 0;
            if (transferThroughputKbps > 0 &&
                    transferThroughputKbps <= MAX_VALID_TRANSFER_KBPS) {
                this.transferThroughputHistoryKbps.push(transferThroughputKbps);
                if (this.transferThroughputHistoryKbps.length > 8) {
                    this.transferThroughputHistoryKbps.shift();
                }
            }
            const completedAtMs = performance.now() - Number(
                root.__SAFESABR_EXPERIMENT__ &&
                root.__SAFESABR_EXPERIMENT__.clock_origin_ms || performance.now()
            );
            const decision = this.decisionLog.find(
                (row) => row.chunk === Number(request.index)
            );
            if (decision && Number.isFinite(Number(decision.at_ms))) {
                const serviceSeconds = Math.max(
                    (completedAtMs - Number(decision.at_ms)) / 1000,
                    1e-3
                );
                const serviceMbps = bytes * 8 / 1e6 / serviceSeconds;
                if (Number.isFinite(serviceMbps) && serviceMbps > 0) {
                    this.serviceThroughputHistoryMbps.push(serviceMbps);
                    if (this.serviceThroughputHistoryMbps.length > 8) {
                        this.serviceThroughputHistoryMbps.shift();
                    }
                }
            }
            this.throughputFeatures.shift();
            this.delayFeatures.shift();
            this.throughputFeatures.push(delayMs > 0 ? bytes / delayMs / 1000 / 10 : 0);
            this.delayFeatures.push(delayMs > 0 ? delayMs / 1000 / 10 : 0);
            this.lastAction = action;
            this.completedChunks += 1;
            this.remainingChunks = Math.max(this.totalChunks - this.completedChunks, 0);
            this.nextSizes = this.getChunkSizes(this.completedChunks);
            this.updateAdvisor(
                transferThroughputKbps,
                bufferSeconds,
                Number(request.duration) || 4
            );
            if (this.executionMode === 'stateful') {
                this.updateEnvelopeAfterCompletion(bufferSeconds);
            } else if (this.executionMode === 'unified') {
                this.updateUnifiedAfterCompletion(bufferSeconds);
            }
            if (this.pendingRescue !== null &&
                    Number(request.index) === this.pendingRescue.chunkIndex &&
                    action <= this.pendingRescue.action) {
                // The replacement is now appended. dash.js may ask for the next
                // quality synchronously, so release the one-chunk override here.
                this.pendingRescue = null;
            }
        }

        observeRequestStart(request, bufferSeconds) {
            if (!request || !Number.isFinite(request.index) ||
                    this.launchedChunks.has(Number(request.index))) {
                return;
            }
            const chunk = Number(request.index);
            this.launchedChunks.add(chunk);
            const decision = this.decisionLog.find((row) => row.chunk === chunk);
            if (!decision) {
                return;
            }
            const launchBufferSeconds = Math.max(Number(bufferSeconds) || 0, 0);
            const erosionSeconds = Math.max(
                Number(decision.buffer_s || 0) - launchBufferSeconds,
                0
            );
            this.launchErosionHistorySeconds.push(erosionSeconds);
            if (this.launchErosionHistorySeconds.length > 8) {
                this.launchErosionHistorySeconds.shift();
            }
            decision.launch_buffer_s = launchBufferSeconds;
            decision.launch_erosion_s = erosionSeconds;
        }

        forceRescue(chunkIndex, action, capacityKbps) {
            this.pendingRescue = {
                chunkIndex: Number(chunkIndex),
                action: Number(action),
            };
            if (this.executionMode === 'stateful') {
                this.enterBufferRecovery(action);
            } else if (this.executionMode === 'unified') {
                this.closeUnifiedTopGate('in_flight_rescue');
            }
        }

        enterBufferRecovery(action = STARTUP_CAP_ACTION) {
            if (this.executionState !== 'buffer_recovery') {
                this.recoveryEpisodes += 1;
            }
            this.executionState = 'buffer_recovery';
            this.envelopeCapAction = Math.min(
                this.envelopeCapAction,
                Math.max(0, Math.min(Number(action), STARTUP_CAP_ACTION))
            );
            this.raiseEvidence = 0;
            this.lowerEvidence = 0;
            this.policyLowerEvidence = 0;
        }

        updateEnvelopeAfterCompletion(bufferSeconds) {
            const addedRebufferSeconds = Math.max(
                this.sessionRebufferSeconds - this.lastObservedRebufferSeconds,
                0
            );
            const capacityKbps = this.safeTransferCapacityKbps();
            if (addedRebufferSeconds >= RECOVERY_TRIGGER_REBUFFER_S &&
                    this.executionState !== 'startup_buffering') {
                this.enterBufferRecovery();
            }

            if ((this.executionState === 'startup_buffering' ||
                    this.executionState === 'buffer_recovery') &&
                    Number(bufferSeconds) >= STARTUP_RESERVE_BUFFER_S) {
                this.executionState = 'capacity_envelope';
                this.envelopeCapAction = Number.isFinite(capacityKbps)
                    ? Math.min(this.sustainableAction(capacityKbps), TOP_ACTION - 1)
                    : STARTUP_CAP_ACTION;
                this.raiseEvidence = 0;
                this.lowerEvidence = 0;
            } else if (this.executionState === 'capacity_envelope' &&
                    Number.isFinite(capacityKbps)) {
                const candidate = this.sustainableAction(capacityKbps);
                if (this.envelopeCapAction === TOP_ACTION &&
                        Number(bufferSeconds) < TOP_EXIT_BUFFER_S &&
                        capacityKbps < STRONG_TOP_CAPACITY_KBPS) {
                    this.envelopeCapAction = TOP_ACTION - 1;
                    this.raiseEvidence = 0;
                    this.lowerEvidence = 0;
                } else if (candidate < this.envelopeCapAction) {
                    this.raiseEvidence = 0;
                    if (Number(bufferSeconds) <= ENVELOPE_EMERGENCY_BUFFER_S) {
                        this.envelopeCapAction = candidate;
                        this.lowerEvidence = 0;
                    } else {
                        this.lowerEvidence += 1;
                        if (this.lowerEvidence >= ENVELOPE_LOWER_EVIDENCE) {
                            this.envelopeCapAction = Math.max(
                                candidate,
                                this.envelopeCapAction - 1
                            );
                            this.lowerEvidence = 0;
                        }
                    }
                } else if (candidate > this.envelopeCapAction) {
                    this.lowerEvidence = 0;
                    const canEnterTop = this.envelopeCapAction < TOP_ACTION - 1 ||
                        Number(bufferSeconds) >= TOP_ENTER_BUFFER_S ||
                        capacityKbps >= STRONG_TOP_CAPACITY_KBPS;
                    this.raiseEvidence = canEnterTop ? this.raiseEvidence + 1 : 0;
                    if (canEnterTop && this.raiseEvidence >= ENVELOPE_RAISE_EVIDENCE) {
                        this.envelopeCapAction += 1;
                        this.raiseEvidence = 0;
                    }
                } else {
                    this.raiseEvidence = 0;
                    this.lowerEvidence = 0;
                }
            }
            this.lastObservedRebufferSeconds = this.sessionRebufferSeconds;
        }

        requestDurationMs(request) {
            if (request.trequest && request.tfinish) {
                return Math.max(request.tfinish.getTime() - request.trequest.getTime(), 1);
            }
            if (Array.isArray(request.traces)) {
                return Math.max(request.traces.reduce((sum, trace) => sum + Number(trace.d || 0), 0), 1);
            }
            return 1;
        }

        bufferSeconds() {
            const value = this.player.getBufferLength('video');
            return Number.isFinite(value) ? value : 0;
        }

        setOracleTrace(points) {
            if (!Array.isArray(points) || points.length === 0) {
                this.oracleTrace = null;
                return;
            }
            this.oracleTrace = points.map((point) => [Number(point[0]), Number(point[1])]);
        }

        enableOracleLaunchProjection() {
            this.oracleLaunchProjection = true;
        }

        enableOracleValueProjection() {
            this.oracleValueProjection = true;
        }

        oracleDownloadSeconds(bytes, startS) {
            if (!Array.isArray(this.oracleTrace) || this.oracleTrace.length === 0 || bytes <= 0) {
                return NaN;
            }
            let remainingBits = bytes * 8;
            let cursorS = Math.max(Number(startS) || 0, 0);
            let pointIndex = 0;
            while (pointIndex + 1 < this.oracleTrace.length &&
                    this.oracleTrace[pointIndex + 1][0] <= cursorS) {
                pointIndex += 1;
            }
            while (remainingBits > 0) {
                const rateBitsPerS = Math.max(this.oracleTrace[pointIndex][1], 0.1) * 1000 * 1000;
                const nextS = pointIndex + 1 < this.oracleTrace.length
                    ? this.oracleTrace[pointIndex + 1][0]
                    : Infinity;
                const availableS = nextS - cursorS;
                if (!Number.isFinite(availableS) || remainingBits <= rateBitsPerS * availableS) {
                    return cursorS - startS + remainingBits / rateBitsPerS;
                }
                remainingBits -= rateBitsPerS * availableS;
                cursorS = nextS;
                pointIndex += 1;
            }
            return cursorS - startS;
        }

        oracleProjectedAction(requestedAction, bufferSeconds) {
            const startS = this.traceElapsedSeconds();
            const usableBufferS = Math.max(Number(bufferSeconds) - 0.5, 0);
            let highestFeasible = null;
            let fastest = null;
            for (let action = 0; action <= requestedAction; action += 1) {
                const downloadS = this.oracleDownloadSeconds(this.nextSizes[action], startS);
                if (!Number.isFinite(downloadS)) {
                    continue;
                }
                if (fastest === null || downloadS < fastest.downloadS) {
                    fastest = { action, downloadS };
                }
                if (downloadS <= usableBufferS &&
                        (highestFeasible === null || action > highestFeasible.action)) {
                    highestFeasible = { action, downloadS };
                }
            }
            if (highestFeasible !== null) {
                return highestFeasible.action;
            }
            return fastest === null ? requestedAction : fastest.action;
        }

        oracleValueProjectedAction(requestedAction, bufferSeconds) {
            const startS = this.traceElapsedSeconds();
            const usableBufferS = Math.max(
                Number(bufferSeconds) - ORACLE_LAUNCH_GUARD_S,
                0
            );
            const previousMbps = this.bitrates[this.lastAction] / 1000;
            let best = null;
            for (let action = 0; action <= requestedAction; action += 1) {
                const downloadS = this.oracleDownloadSeconds(this.nextSizes[action], startS);
                if (!Number.isFinite(downloadS)) {
                    continue;
                }
                const bitrateMbps = this.bitrates[action] / 1000;
                const predictedStallS = Math.max(downloadS - usableBufferS, 0);
                const value = bitrateMbps -
                    REBUFFER_PENALTY * predictedStallS -
                    Math.abs(bitrateMbps - previousMbps);
                if (best === null || value > best.value ||
                        (value === best.value && action > best.action)) {
                    best = { action, value };
                }
            }
            const selected = best === null ? requestedAction : best.action;
            if (selected < requestedAction) {
                this.preflightCappedDecisions += 1;
            }
            return selected;
        }

        harmonicMean(values) {
            const clean = values.filter((value) => Number.isFinite(value) && value > 0);
            return clean.length
                ? clean.length / clean.reduce((sum, value) => sum + 1 / value, 0)
                : NaN;
        }

        riskCriticFeatures(requestedAction, bufferSeconds) {
            const recent = this.serviceThroughputHistoryMbps.slice(-5);
            const lastService = recent.length ? recent[recent.length - 1] : NaN;
            const harmonic = this.harmonicMean(recent);
            const min3 = recent.length ? Math.min(...recent.slice(-3)) : NaN;
            const mean = recent.length
                ? recent.reduce((sum, value) => sum + value, 0) / recent.length
                : NaN;
            const variance = recent.length
                ? recent.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
                    recent.length
                : NaN;
            const serviceCv = mean > 0 ? Math.sqrt(variance) / mean : NaN;
            const older = recent.length > 1
                ? this.harmonicMean(recent.slice(0, -1))
                : lastService;
            const trend = older > 0 ? lastService / older : NaN;
            const buffer = Math.max(Number(bufferSeconds) || 0, 0);
            const sizeMbit = Number(this.nextSizes[requestedAction] || 0) * 8 / 1e6;
            const predictedDownload = harmonic > 0 ? sizeMbit / harmonic : Infinity;
            return {
                buffer_s: buffer,
                buffer_delta_s: Number.isFinite(this.priorDecisionBufferSeconds)
                    ? buffer - this.priorDecisionBufferSeconds
                    : 0,
                last_service_mbps: lastService,
                harmonic_service_mbps: harmonic,
                min3_service_mbps: min3,
                service_cv: serviceCv,
                service_trend: trend,
                chunk_size_mbit: sizeMbit,
                requested_bitrate_mbps: this.bitrates[requestedAction] / 1000,
                required_rate_mbps: sizeMbit / Math.max(buffer, 0.25),
                predicted_download_s: predictedDownload,
                deadline_slack_s: buffer - predictedDownload,
                seconds_to_handover: this.secondsToNextHandover(),
            };
        }

        riskCriticProbability(features) {
            if (!this.riskCritic || !Array.isArray(this.riskCritic.trees) ||
                    !Array.isArray(this.riskCritic.feature_names)) {
                return NaN;
            }
            const values = this.riskCritic.feature_names.map((name, index) => {
                const value = Number(features[name]);
                return Number.isFinite(value)
                    ? value
                    : Number(this.riskCritic.medians[index] || 0);
            });
            let probability = 0;
            for (const tree of this.riskCritic.trees) {
                let node = 0;
                while (Number(tree.children_left[node]) !== -1) {
                    const feature = Number(tree.feature[node]);
                    node = values[feature] <= Number(tree.threshold[node])
                        ? Number(tree.children_left[node])
                        : Number(tree.children_right[node]);
                }
                const negative = Number(tree.negative_weight[node] || 0);
                const positive = Number(tree.positive_weight[node] || 0);
                probability += positive / Math.max(negative + positive, 1e-12);
            }
            return probability / this.riskCritic.trees.length;
        }

        capacityValueAction(requestedAction, bufferSeconds, capacityKbps) {
            const usableBufferS = Math.max(Number(bufferSeconds) - ORACLE_LAUNCH_GUARD_S, 0);
            const previousMbps = this.bitrates[this.lastAction] / 1000;
            let bestAction = requestedAction;
            let bestValue = -Infinity;
            for (let action = 0; action <= requestedAction; action += 1) {
                const bitrateMbps = this.bitrates[action] / 1000;
                const downloadS = this.estimatedDownloadSeconds(action, capacityKbps);
                const stallS = Math.max(downloadS - usableBufferS, 0);
                const value = bitrateMbps - REBUFFER_PENALTY * stallS -
                    Math.abs(bitrateMbps - previousMbps);
                if (value > bestValue || (value === bestValue && action > bestAction)) {
                    bestAction = action;
                    bestValue = value;
                }
            }
            return bestAction;
        }

        selectiveProjectedAction(requestedAction, bufferSeconds) {
            const features = this.riskCriticFeatures(requestedAction, bufferSeconds);
            const riskScore = requestedAction >= 4
                ? this.riskCriticProbability(features)
                : NaN;
            this.selectiveRiskScore = riskScore;
            this.selectiveReason = 'policy_kept';
            let selected = requestedAction;
            if (Number.isFinite(riskScore) && Number.isFinite(this.riskThreshold) &&
                    riskScore >= this.riskThreshold) {
                selected = Math.max(requestedAction - 1, 0);
                this.selectiveReason = 'risk_critic_adjacent_cap';
            }

            const capacityKbps = this.safeTransferCapacityKbps();
            const usableBufferS = Math.max(
                Number(bufferSeconds) - this.conservativeLaunchErosionSeconds(),
                0
            );
            const predictedOverrunS = Number.isFinite(capacityKbps)
                ? this.estimatedDownloadSeconds(requestedAction, capacityKbps) - usableBufferS
                : -Infinity;
            if (predictedOverrunS >= SELECTIVE_EXTREME_OVERRUN_S) {
                const emergencyAction = this.capacityValueAction(
                    requestedAction,
                    bufferSeconds,
                    capacityKbps
                );
                if (emergencyAction < selected) {
                    selected = emergencyAction;
                    this.selectiveReason = 'extreme_infeasibility_projection';
                }
            }
            if (selected < requestedAction) {
                this.selectiveCappedDecisions += 1;
                this.preflightCappedDecisions += 1;
            }
            return selected;
        }

        safeTransferCapacityKbps() {
            const history = this.transferThroughputHistoryKbps.slice(-SERVICE_HISTORY)
                .filter((value) => Number.isFinite(value) && value > 0 &&
                    value <= MAX_VALID_TRANSFER_KBPS)
                .sort((left, right) => left - right);
            if (history.length === 0) {
                return NaN;
            }
            const index = Math.floor(SERVICE_QUANTILE * (history.length - 1));
            return history[index] * SERVICE_MARGIN;
        }

        latestTransferCapacityKbps() {
            for (let index = this.transferThroughputHistoryKbps.length - 1;
                    index >= 0; index -= 1) {
                const value = Number(this.transferThroughputHistoryKbps[index]);
                if (Number.isFinite(value) && value > 0 &&
                        value <= MAX_VALID_TRANSFER_KBPS) {
                    return value;
                }
            }
            return NaN;
        }

        updateAdvisor(measuredKbps, bufferSeconds, chunkDurationSeconds) {
            if (!this.advisorPlanner || !Number.isFinite(measuredKbps) || measuredKbps <= 0) {
                return;
            }
            let currentError = 0;
            if (this.advisorPastEstimatesKbps.length > 0) {
                const previous = this.advisorPastEstimatesKbps[
                    this.advisorPastEstimatesKbps.length - 1
                ];
                currentError = Math.abs(previous - measuredKbps) /
                    Math.max(measuredKbps, 1e-6);
            }
            this.advisorPastErrors.push(currentError);
            this.advisorThroughputHistoryKbps.push(measuredKbps);
            const recent = this.advisorThroughputHistoryKbps.slice(-SERVICE_HISTORY);
            const harmonic = recent.length /
                recent.reduce((sum, value) => sum + 1 / value, 0);
            const maximumError = Math.max(...this.advisorPastErrors.slice(-SERVICE_HISTORY));
            this.advisorPastEstimatesKbps.push(harmonic);
            this.advisorCapacityKbps = harmonic / (1 + maximumError);
            this.advisorAction = this.advisorPlanner.choose(
                this.lastAction,
                this.advisorCapacityKbps,
                Math.max(Number(bufferSeconds) || 0, 0) +
                    Math.max(Number(chunkDurationSeconds) || 4, 0),
                Math.min(this.completedChunks, this.totalChunks - 1)
            );
        }

        estimatedDownloadSeconds(action, capacityKbps) {
            const bytes = Number(this.nextSizes[action] || 0);
            return bytes > 0 && capacityKbps > 0
                ? bytes * 8 / (capacityKbps * 1000)
                : Infinity;
        }

        highestActionWithin(requestedAction, capacityKbps, downloadLimitS) {
            let selected = 0;
            for (let action = 0; action <= requestedAction; action += 1) {
                if (this.estimatedDownloadSeconds(action, capacityKbps) <= downloadLimitS) {
                    selected = action;
                }
            }
            return selected;
        }

        conservativeLaunchErosionSeconds() {
            const values = this.launchErosionHistorySeconds.slice()
                .filter((value) => Number.isFinite(value) && value >= 0)
                .sort((left, right) => left - right);
            if (!values.length) {
                return 0;
            }
            return values[Math.floor(0.75 * (values.length - 1))];
        }

        admissionProjectedAction(requestedAction, bufferSeconds) {
            if (requestedAction < TOP_ACTION) {
                return requestedAction;
            }
            const currentBufferSeconds = Math.max(Number(bufferSeconds) || 0, 0);
            const capacityKbps = this.safeTransferCapacityKbps();
            const launchBufferSeconds = Math.max(
                currentBufferSeconds - this.conservativeLaunchErosionSeconds(),
                0
            );
            const estimatedDownloadSeconds = Number.isFinite(capacityKbps)
                ? this.estimatedDownloadSeconds(TOP_ACTION, capacityKbps)
                : Infinity;
            const hasEvidence = this.transferThroughputHistoryKbps.length >= ADMISSION_MIN_HISTORY;
            const admitted = currentBufferSeconds >= this.admissionBufferSeconds &&
                hasEvidence &&
                estimatedDownloadSeconds + ADMISSION_BUFFER_GUARD_S <= launchBufferSeconds;
            if (admitted) {
                return requestedAction;
            }
            this.preflightCappedDecisions += 1;
            return ADMISSION_FALLBACK_ACTION;
        }

        setUnifiedState(nextState, reason) {
            if (this.executionState === nextState) {
                return;
            }
            this.unifiedStateChanges.push({
                chunk: this.completedChunks,
                from: this.executionState,
                to: nextState,
                reason,
            });
            this.executionState = nextState;
        }

        closeUnifiedTopGate(reason) {
            this.setUnifiedState('unified_top_closed', reason);
            this.unifiedTopFeasibleEvidence = 0;
            this.unifiedTopInfeasibleEvidence = 0;
            this.unifiedCooldownChunks = Math.max(
                this.unifiedCooldownChunks,
                UNIFIED_COOLDOWN_CHUNKS
            );
        }

        updateUnifiedAfterCompletion(bufferSeconds) {
            if (this.unifiedCooldownChunks > 0) {
                this.unifiedCooldownChunks -= 1;
            }
            const addedRebufferSeconds = Math.max(
                this.sessionRebufferSeconds - this.lastObservedRebufferSeconds,
                0
            );
            if (addedRebufferSeconds > 0.25 ||
                    Number(bufferSeconds) <= UNIFIED_EMERGENCY_BUFFER_S) {
                this.closeUnifiedTopGate(
                    addedRebufferSeconds > 0.25 ? 'observed_rebuffer' : 'emergency_buffer'
                );
            }
            this.lastObservedRebufferSeconds = this.sessionRebufferSeconds;
        }

        stabilizeUnifiedPolicyAction(requestedAction, bufferSeconds, capacityKbps) {
            if (requestedAction >= this.lastAction) {
                this.unifiedPolicyLowerEvidence = 0;
                return requestedAction;
            }
            const usableBufferSeconds = Math.max(
                Number(bufferSeconds) - this.conservativeLaunchErosionSeconds(),
                0
            );
            const lastActionFeasible = Number.isFinite(capacityKbps) &&
                this.estimatedDownloadSeconds(this.lastAction, capacityKbps) +
                    ADMISSION_BUFFER_GUARD_S <= usableBufferSeconds;
            const emergency = Number(bufferSeconds) <= UNIFIED_EMERGENCY_BUFFER_S ||
                !lastActionFeasible;
            if (emergency) {
                this.unifiedPolicyLowerEvidence = 0;
                return Math.max(requestedAction, this.lastAction - 1);
            }
            this.unifiedPolicyLowerEvidence += 1;
            if (this.unifiedPolicyLowerEvidence < UNIFIED_POLICY_LOWER_EVIDENCE) {
                return this.lastAction;
            }
            this.unifiedPolicyLowerEvidence = 0;
            return Math.max(requestedAction, this.lastAction - 1);
        }

        unifiedProjectedAction(requestedAction, bufferSeconds) {
            const currentBufferSeconds = Math.max(Number(bufferSeconds) || 0, 0);
            const capacityKbps = this.safeTransferCapacityKbps();
            const launchBufferSeconds = Math.max(
                currentBufferSeconds - this.conservativeLaunchErosionSeconds(),
                0
            );
            const hasEvidence = this.transferThroughputHistoryKbps.length >= ADMISSION_MIN_HISTORY;
            const topDownloadSeconds = Number.isFinite(capacityKbps)
                ? this.estimatedDownloadSeconds(TOP_ACTION, capacityKbps)
                : Infinity;
            const physicallyFeasible = hasEvidence &&
                topDownloadSeconds + ADMISSION_BUFFER_GUARD_S <= launchBufferSeconds;
            const stabilizedAction = this.stabilizeUnifiedPolicyAction(
                requestedAction,
                currentBufferSeconds,
                capacityKbps
            );
            this.lastStabilizedPolicyAction = stabilizedAction;

            if (this.executionState === 'unified_top_open') {
                const emergencyExit = currentBufferSeconds <= UNIFIED_EMERGENCY_BUFFER_S;
                const retainTop = currentBufferSeconds >= UNIFIED_TOP_EXIT_BUFFER_S &&
                    physicallyFeasible;
                const deadlineMissSeconds = topDownloadSeconds + ADMISSION_BUFFER_GUARD_S -
                    launchBufferSeconds;
                if (emergencyExit || deadlineMissSeconds >= UNIFIED_HARD_DEADLINE_MISS_S) {
                    this.closeUnifiedTopGate(
                        emergencyExit ? 'emergency_buffer' : 'hard_deadline_miss'
                    );
                } else if (!retainTop) {
                    this.unifiedTopInfeasibleEvidence += 1;
                    if (this.unifiedTopInfeasibleEvidence >= UNIFIED_EXIT_EVIDENCE) {
                        this.closeUnifiedTopGate('deadline_infeasible');
                    }
                } else {
                    this.unifiedTopInfeasibleEvidence = 0;
                }
            } else {
                const canEnter = this.unifiedCooldownChunks === 0 &&
                    currentBufferSeconds >= UNIFIED_TOP_ENTER_BUFFER_S && physicallyFeasible;
                this.unifiedTopFeasibleEvidence = canEnter
                    ? this.unifiedTopFeasibleEvidence + 1
                    : 0;
                if (this.unifiedTopFeasibleEvidence >= UNIFIED_ENTRY_EVIDENCE) {
                    this.setUnifiedState('unified_top_open', 'sustained_deadline_feasibility');
                    this.unifiedTopFeasibleEvidence = 0;
                    this.unifiedTopInfeasibleEvidence = 0;
                }
            }

            let selected = stabilizedAction;
            if (selected === TOP_ACTION && this.executionState !== 'unified_top_open') {
                selected = ADMISSION_FALLBACK_ACTION;
            }
            if (selected < requestedAction) {
                this.preflightCappedDecisions += 1;
            }
            return selected;
        }

        sustainableAction(capacityKbps) {
            return this.highestActionWithin(
                TOP_ACTION,
                capacityKbps,
                ENVELOPE_DOWNLOAD_TARGET_S
            );
        }

        statefulProjectedAction(requestedAction, bufferSeconds) {
            const latestCapacityKbps = this.latestTransferCapacityKbps();
            let startupFastPathReleased = false;
            if (this.executionState === 'startup_buffering' &&
                    this.completedChunks >= STARTUP_FAST_PATH_MIN_CHUNKS &&
                    latestCapacityKbps >= STARTUP_FAST_PATH_CAPACITY_KBPS) {
                this.executionState = 'capacity_envelope';
                this.envelopeCapAction = TOP_ACTION;
                this.raiseEvidence = 0;
                this.lowerEvidence = 0;
                startupFastPathReleased = true;
            }
            if (!startupFastPathReleased && this.executionState === 'capacity_envelope' &&
                    this.envelopeCapAction === TOP_ACTION &&
                    Number(bufferSeconds) < TOP_EXIT_BUFFER_S &&
                    this.safeTransferCapacityKbps() < STRONG_TOP_CAPACITY_KBPS) {
                this.envelopeCapAction = TOP_ACTION - 1;
                this.raiseEvidence = 0;
                this.lowerEvidence = 0;
                this.preflightCappedDecisions += 1;
            }
            let stabilizedPolicyAction = requestedAction;
            const safetyForcesLower = this.envelopeCapAction < this.lastAction;
            if (requestedAction < this.lastAction && !safetyForcesLower &&
                    Number(bufferSeconds) > POLICY_EMERGENCY_BUFFER_S) {
                this.policyLowerEvidence += 1;
                if (this.policyLowerEvidence < POLICY_LOWER_EVIDENCE) {
                    stabilizedPolicyAction = this.lastAction;
                } else {
                    stabilizedPolicyAction = Math.max(
                        requestedAction,
                        this.lastAction - 1
                    );
                    this.policyLowerEvidence = 0;
                }
            } else {
                this.policyLowerEvidence = 0;
            }
            this.lastStabilizedPolicyAction = stabilizedPolicyAction;
            const advisorGuidedAction = Number.isFinite(this.advisorAction)
                ? Math.min(stabilizedPolicyAction, this.advisorAction)
                : stabilizedPolicyAction;
            let selected = advisorGuidedAction;
            const requiresEnvelope = this.executionState !== 'capacity_envelope' ||
                Number(bufferSeconds) < TOP_EXIT_BUFFER_S;
            if (requiresEnvelope && selected > this.envelopeCapAction) {
                selected = this.envelopeCapAction;
                this.riskGateCappedDecisions += 1;
            }
            const capacityKbps = this.safeTransferCapacityKbps();
            if (selected === TOP_ACTION &&
                    this.secondsToNextHandover() <= HANDOVER_GUARD_WINDOW_S &&
                    (!Number.isFinite(capacityKbps) ||
                    capacityKbps < HANDOVER_TOP_CAPACITY_KBPS)) {
                selected = TOP_ACTION - 1;
                this.handoverCappedDecisions += 1;
            }
            if (selected < requestedAction) {
                this.recoveryCappedDecisions += 1;
            }
            return selected;
        }

        secondsToNextHandover() {
            const currentSecond = ((this.startSecond + this.traceElapsedSeconds()) % 60 + 60) % 60;
            for (const handoverSecond of HANDOVER_SECONDS) {
                const delta = handoverSecond - currentSecond;
                if (delta >= 0) {
                    return delta;
                }
            }
            return 60 - currentSecond + HANDOVER_SECONDS[0];
        }

        traceElapsedSeconds() {
            return Number.isFinite(this.traceStartedAt)
                ? Math.max((performance.now() - this.traceStartedAt) / 1000, 0)
                : 0;
        }

        recordRescue(decision, elapsedMs) {
            this.rescueDecisionMs.push(elapsedMs);
            this.rescueDecisions.push(decision);
        }

        recordRescueDebug(event) {
            this.rescueDebug.push({
                at_ms: performance.now() - Number(
                    root.__SAFESABR_EXPERIMENT__ &&
                    root.__SAFESABR_EXPERIMENT__.clock_origin_ms || performance.now()
                ),
                ...event,
            });
        }
    }

    function SafeSabrQualityRuleClass() {
        const context = this.context;
        const factory = dashjs.FactoryMaker;
        const SwitchRequest = factory.getClassFactoryByName('SwitchRequest');

        function getSwitchRequest(rulesContext) {
            const switchRequest = SwitchRequest(context).create();
            const runtime = root.__SAFESABR_RUNTIME__;
            if (!runtime || !rulesContext || rulesContext.getMediaType() !== 'video') {
                return switchRequest;
            }
            const action = runtime.decide(runtime.bufferSeconds());
            const abrController = rulesContext.getAbrController();
            const mediaInfo = rulesContext.getMediaInfo();
            switchRequest.representation = abrController.getOptimalRepresentationForBitrate(
                mediaInfo,
                runtime.bitrates[action],
                true
            );
            switchRequest.priority = SwitchRequest.PRIORITY.STRONG;
            switchRequest.reason = {
                action,
                source: runtime.pendingRescue === null
                    ? 'SafeSABR-Session-CVaR'
                    : 'SafeSABR-V4-Rescue-Replacement',
            };
            return switchRequest;
        }

        return { getSwitchRequest };
    }

    SafeSabrQualityRuleClass.__dashjs_factory_name = 'SafeSabrQualityRule';
    root.SafeSabrPolicy = SafeSabrPolicy;
    root.SafeSabrRuntime = SafeSabrRuntime;
    root.SafeSabrQualityRule = typeof dashjs === 'undefined'
        ? null
        : dashjs.FactoryMaker.getClassFactory(SafeSabrQualityRuleClass);
})(typeof window === 'undefined' ? globalThis : window);
