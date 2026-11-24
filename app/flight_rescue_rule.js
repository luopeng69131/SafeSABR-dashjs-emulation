(function (root) {
    'use strict';

    const CHECK_INTERVAL_MS = 250;
    const ESTIMATOR_WINDOW_MS = 1000;
    const MIN_SAMPLES = 2;
    const MIN_OBSERVATION_MS = 500;
    const BUFFER_GUARD_S = 0.5;
    const MIN_SAVINGS_S = 0.25;
    const RESTART_RTT_S = 0.1;
    const MAX_RESCUES = 1;
    const TOP_ACTION = 5;
    const REBUFFER_PENALTY = 40;
    const UNIFIED_MIN_OVERRUN_S = 4;
    const UNIFIED_MIN_COMPLETION_SAVINGS_S = 0.5;
    const UNIFIED_MAX_PROGRESS_RATIO = 0.6;
    const UNIFIED_MIN_QOE_GAIN = 0;

    root.__SAFESABR_RESCUE_DIAG__ = { counts: {}, samples: [] };

    function countRuleEvent(reason, details = {}) {
        const diagnostic = root.__SAFESABR_RESCUE_DIAG__;
        diagnostic.counts[reason] = (diagnostic.counts[reason] || 0) + 1;
        if (diagnostic.samples.length < 40) {
            diagnostic.samples.push({ reason, ...details });
        }
    }

    function recentThroughputKbps(request) {
        const traces = Array.isArray(request.traces) ? request.traces : [];
        if (traces.length < MIN_SAMPLES) {
            return NaN;
        }
        let durationMs = 0;
        let bytes = 0;
        // dash.js includes request latency in the first trace entry. Excluding it
        // matches the native AbandonRequestsRule throughput semantics.
        for (let index = traces.length - 1; index > 0 && durationMs < ESTIMATOR_WINDOW_MS; index -= 1) {
            durationMs += Number(traces[index].d || 0);
            const block = traces[index].b;
            bytes += Array.isArray(block) ? Number(block[0] || 0) : 0;
        }
        return durationMs > 0 ? (8 * bytes) / durationMs : NaN;
    }

    function oracleDownloadSeconds(points, startS, bytes) {
        if (!Array.isArray(points) || points.length === 0 || bytes <= 0) {
            return NaN;
        }
        let remainingBits = bytes * 8;
        let cursorS = Math.max(Number(startS) || 0, 0);
        let pointIndex = 0;
        while (pointIndex + 1 < points.length && Number(points[pointIndex + 1][0]) <= cursorS) {
            pointIndex += 1;
        }
        while (remainingBits > 0) {
            const rateMbps = Math.max(Number(points[pointIndex][1]) || 0, 0.1);
            const nextS = pointIndex + 1 < points.length
                ? Number(points[pointIndex + 1][0])
                : Infinity;
            const availableS = nextS - cursorS;
            const rateBitsPerS = rateMbps * 1000 * 1000;
            if (!Number.isFinite(availableS) || remainingBits <= rateBitsPerS * availableS) {
                return cursorS - startS + remainingBits / rateBitsPerS;
            }
            remainingBits -= rateBitsPerS * availableS;
            cursorS = nextS;
            pointIndex += 1;
        }
        return cursorS - startS;
    }

    function evaluateUnifiedRescue(input) {
        const currentAction = Number(input.currentAction);
        const rescueAction = currentAction - 1;
        const capacityKbps = Number(input.capacityKbps);
        const remainingBytes = Number(input.remainingBytes);
        const totalBytes = Number(input.totalBytes);
        const replacementBytes = Number(input.replacementBytes);
        const usableBufferS = Math.max(Number(input.usableBufferS) || 0, 0);
        const previousAction = Number(input.previousAction);
        const bitrates = input.bitrates;
        if (currentAction !== TOP_ACTION || rescueAction < 0 ||
                !Number.isFinite(capacityKbps) || capacityKbps <= 0 ||
                remainingBytes <= 0 || totalBytes <= 0 || replacementBytes <= 0 ||
                !Array.isArray(bitrates)) {
            return { rescue: false, reason: 'invalid_input' };
        }
        const progressRatio = Math.max(1 - remainingBytes / totalBytes, 0);
        const keepS = remainingBytes * 8 / (capacityKbps * 1000);
        const rescueS = RESTART_RTT_S + replacementBytes * 8 / (capacityKbps * 1000);
        const keepStallS = Math.max(keepS - usableBufferS, 0);
        const rescueStallS = Math.max(rescueS - usableBufferS, 0);
        const keepMbps = bitrates[currentAction] / 1000;
        const rescueMbps = bitrates[rescueAction] / 1000;
        const previousMbps = bitrates[previousAction] / 1000;
        const keepQoe = keepMbps - REBUFFER_PENALTY * keepStallS -
            Math.abs(keepMbps - previousMbps);
        const rescueQoe = rescueMbps - REBUFFER_PENALTY * rescueStallS -
            Math.abs(rescueMbps - previousMbps);
        const details = {
            rescueAction,
            progressRatio,
            keepS,
            rescueS,
            keepStallS,
            rescueStallS,
            predictedOverrunS: keepStallS,
            completionSavingsS: keepS - rescueS,
            qoeGain: rescueQoe - keepQoe,
            keepQoe,
            rescueQoe,
        };
        if (progressRatio > UNIFIED_MAX_PROGRESS_RATIO) {
            return { rescue: false, reason: 'replacement_too_late', ...details };
        }
        if (keepStallS < UNIFIED_MIN_OVERRUN_S) {
            return { rescue: false, reason: 'overrun_below_threshold', ...details };
        }
        if (rescueS + UNIFIED_MIN_COMPLETION_SAVINGS_S >= keepS) {
            return { rescue: false, reason: 'insufficient_completion_gain', ...details };
        }
        if (rescueQoe - keepQoe <= UNIFIED_MIN_QOE_GAIN) {
            return { rescue: false, reason: 'non_positive_qoe_gain', ...details };
        }
        return { rescue: true, reason: 'deadline_rescue', ...details };
    }

    function makeFlightRescueRuleClass(useOracle, observeOnly = false, riskAligned = false) {
        function FlightRescueRuleClass() {
        const context = this.context;
        const factory = dashjs.FactoryMaker;
        const SwitchRequest = factory.getClassFactoryByName('SwitchRequest');
        const checkedAt = {};
        const firstSeenAt = {};
        const handledRepresentations = {};
        const rescueCounts = {};
        let sessionRescues = 0;

        function noChange() {
            return SwitchRequest(context).create();
        }

        function recordDebug(runtime, reason, details) {
            if (runtime && typeof runtime.recordRescueDebug === 'function') {
                runtime.recordRescueDebug({ reason, ...details });
            }
        }

        function shouldAbandon(rulesContext) {
            countRuleEvent('called');
            const started = performance.now();
            const runtime = root.__SAFESABR_RUNTIME__;
            if (!runtime || !rulesContext || rulesContext.getMediaType() !== 'video') {
                countRuleEvent('invalid_context', {
                    hasRuntime: Boolean(runtime),
                    hasRulesContext: Boolean(rulesContext),
                });
                return noChange();
            }
            const request = rulesContext.getCurrentRequest();
            if (!request || !Number.isFinite(request.index) || !request.representation) {
                countRuleEvent('invalid_request', {
                    hasRequest: Boolean(request),
                    index: request ? request.index : null,
                    hasRepresentation: Boolean(request && request.representation),
                });
                return noChange();
            }
            const chunkIndex = Number(request.index);
            if (chunkIndex < runtime.completedChunks) {
                countRuleEvent('stale_request', { chunkIndex, completedChunks: runtime.completedChunks });
                return noChange();
            }
            const currentAction = runtime.actionForBitrate(request.representation.bitrateInKbit);
            if ((!useOracle && !riskAligned && currentAction !== TOP_ACTION) ||
                    currentAction <= 0 ||
                    (rescueCounts[chunkIndex] || 0) >= MAX_RESCUES) {
                countRuleEvent('action_filtered', {
                    chunkIndex,
                    currentAction,
                    rescueCount: rescueCounts[chunkIndex] || 0,
                });
                return noChange();
            }
            const key = `${chunkIndex}:${currentAction}`;
            const now = performance.now();
            if (!Number.isFinite(firstSeenAt[key])) {
                firstSeenAt[key] = now;
            }
            const observedMs = now - firstSeenAt[key];
            if (observedMs < MIN_OBSERVATION_MS) {
                countRuleEvent('observation_too_short', { chunkIndex, currentAction, observedMs });
                return noChange();
            }
            if (handledRepresentations[key] || now - (checkedAt[key] || 0) < CHECK_INTERVAL_MS) {
                countRuleEvent('throttled', { chunkIndex, currentAction, observedMs });
                return noChange();
            }
            countRuleEvent('evaluated', { chunkIndex, currentAction, observedMs });
            checkedAt[key] = now;

            const totalBytes = Number(request.bytesTotal || 0);
            const loadedBytes = Number(request.bytesLoaded || 0);
            const capacityKbps = recentThroughputKbps(request);
            if (totalBytes <= loadedBytes || (!useOracle &&
                    (!Number.isFinite(capacityKbps) || capacityKbps <= 0))) {
                recordDebug(runtime, 'missing_progress_estimate', {
                    chunkIndex,
                    currentAction,
                    observedMs,
                    throughputSamples: Array.isArray(request.traces) ? request.traces.length : 0,
                    loadedBytes,
                    totalBytes,
                    capacityKbps,
                    bufferS: runtime.bufferSeconds(),
                });
                return noChange();
            }

            const usableBufferS = Math.max(runtime.bufferSeconds() - BUFFER_GUARD_S, 0);
            const traceNowS = runtime.traceElapsedSeconds();
            const keepS = useOracle
                ? oracleDownloadSeconds(runtime.oracleTrace, traceNowS, totalBytes - loadedBytes)
                : ((totalBytes - loadedBytes) * 8) / (capacityKbps * 1000);
            if (!Number.isFinite(keepS)) {
                recordDebug(runtime, 'non_finite_keep_time', {
                    chunkIndex, currentAction, observedMs, capacityKbps, usableBufferS,
                });
                return noChange();
            }
            recordDebug(runtime, 'progress_snapshot', {
                chunkIndex,
                currentAction,
                observedMs,
                loadedBytes,
                totalBytes,
                progressRatio: totalBytes > 0 ? loadedBytes / totalBytes : null,
                capacityKbps,
                keepS,
                usableBufferS,
                predictedOverrunS: Math.max(keepS - usableBufferS, 0),
            });
            if (keepS <= usableBufferS) {
                recordDebug(runtime, 'keep_within_buffer', {
                    chunkIndex, currentAction, observedMs, capacityKbps, keepS, usableBufferS,
                });
                return noChange();
            }
            const previousMbps = runtime.bitrates[runtime.lastAction] / 1000;
            const keepMbps = runtime.bitrates[currentAction] / 1000;
            const keepStallS = Math.max(keepS - usableBufferS, 0);
            const keepQoe = keepMbps - REBUFFER_PENALTY * keepStallS -
                Math.abs(keepMbps - previousMbps);
            const sizes = runtime.getChunkSizes(chunkIndex);
            const candidates = [];
            for (let action = 0; action < currentAction; action += 1) {
                const replacementBytes = Number(sizes[action] || 0);
                if (replacementBytes <= 0) {
                    continue;
                }
                const rescueS = useOracle
                    ? RESTART_RTT_S + oracleDownloadSeconds(
                        runtime.oracleTrace,
                        traceNowS + RESTART_RTT_S,
                        replacementBytes
                    )
                    : RESTART_RTT_S + (replacementBytes * 8) / (capacityKbps * 1000);
                if (rescueS + MIN_SAVINGS_S < keepS) {
                    const rescueMbps = runtime.bitrates[action] / 1000;
                    const rescueStallS = Math.max(rescueS - usableBufferS, 0);
                    const rescueQoe = rescueMbps - REBUFFER_PENALTY * rescueStallS -
                        Math.abs(rescueMbps - previousMbps);
                    const returnSwitchCost = riskAligned
                        ? Math.abs(keepMbps - rescueMbps)
                        : 0;
                    candidates.push({
                        action,
                        rescueS,
                        rescueStallS,
                        rescueQoe,
                        returnSwitchCost,
                        adjustedRescueQoe: rescueQoe - returnSwitchCost,
                    });
                }
            }
            if (candidates.length === 0) {
                recordDebug(runtime, 'no_faster_replacement', {
                    chunkIndex, currentAction, observedMs, capacityKbps, keepS, usableBufferS,
                });
                return noChange();
            }
            const selected = candidates.reduce((best, item) => {
                if (item.adjustedRescueQoe > best.adjustedRescueQoe ||
                        (item.adjustedRescueQoe === best.adjustedRescueQoe &&
                        item.action > best.action)) {
                    return item;
                }
                return best;
            });
            const predictedStallSavingS = keepStallS - selected.rescueStallS;
            const protectsSevereBudget = riskAligned &&
                runtime.sessionRebufferSeconds + keepStallS > 10 &&
                predictedStallSavingS >= 0.5;
            if (selected.adjustedRescueQoe <= keepQoe && !protectsSevereBudget) {
                recordDebug(runtime, 'non_positive_qoe_gain', {
                    chunkIndex,
                    currentAction,
                    rescueAction: selected.action,
                    observedMs,
                    capacityKbps,
                    keepS,
                    rescueS: selected.rescueS,
                    usableBufferS,
                    keepQoe,
                    rescueQoe: selected.rescueQoe,
                    adjustedRescueQoe: selected.adjustedRescueQoe,
                    returnSwitchCost: selected.returnSwitchCost,
                    predictedStallSavingS,
                    protectsSevereBudget,
                });
                return noChange();
            }

            if (observeOnly) {
                recordDebug(runtime, 'would_rescue', {
                    chunkIndex,
                    currentAction,
                    rescueAction: selected.action,
                    observedMs,
                    loadedBytes,
                    totalBytes,
                    capacityKbps,
                    keepS,
                    rescueS: selected.rescueS,
                    usableBufferS,
                    keepQoe,
                    rescueQoe: selected.rescueQoe,
                    keepStallS,
                    rescueStallS: selected.rescueStallS,
                });
                return noChange();
            }

            const abrController = rulesContext.getAbrController();
            const mediaInfo = rulesContext.getMediaInfo();
            const representation = abrController.getOptimalRepresentationForBitrate(
                mediaInfo,
                runtime.bitrates[selected.action],
                true
            );
            if (!representation || representation.bitrateInKbit >= request.representation.bitrateInKbit) {
                recordDebug(runtime, 'replacement_unavailable', {
                    chunkIndex, currentAction, rescueAction: selected.action, observedMs,
                });
                return noChange();
            }

            const switchRequest = SwitchRequest(context).create();
            switchRequest.representation = representation;
            switchRequest.priority = SwitchRequest.PRIORITY.STRONG;
            switchRequest.reason = {
                source: useOracle
                    ? 'SafeSABR-Diagnostic-Oracle-Flight-Rescue'
                    : riskAligned
                    ? 'SafeSABR-Risk-Aligned-Flight-Rescue'
                    : 'SafeSABR-V4-Flight-Rescue',
                chunkIndex,
                currentAction,
                rescueAction: selected.action,
                capacityKbps,
                keepS,
                rescueS: selected.rescueS,
                usableBufferS,
                keepQoe,
                rescueQoe: selected.rescueQoe,
                adjustedRescueQoe: selected.adjustedRescueQoe,
                returnSwitchCost: selected.returnSwitchCost,
                qoeGain: selected.adjustedRescueQoe - keepQoe,
                predictedStallSavingS,
                protectsSevereBudget,
                keepStallS,
                rescueStallS: selected.rescueStallS,
            };
            runtime.forceRescue(chunkIndex, selected.action, capacityKbps);
            handledRepresentations[key] = true;
            rescueCounts[chunkIndex] = (rescueCounts[chunkIndex] || 0) + 1;
            sessionRescues += 1;
            runtime.recordRescue({
                ...switchRequest.reason,
                bytesLoaded: loadedBytes,
                bytesTotal: totalBytes,
                throughputSamples: request.traces.length,
                observedMs,
                rescueCount: rescueCounts[chunkIndex],
                sessionRescueCount: sessionRescues,
            }, performance.now() - started);
            return switchRequest;
        }

        function reset() {
            Object.keys(checkedAt).forEach((key) => delete checkedAt[key]);
            Object.keys(firstSeenAt).forEach((key) => delete firstSeenAt[key]);
            Object.keys(handledRepresentations).forEach((key) => delete handledRepresentations[key]);
            Object.keys(rescueCounts).forEach((key) => delete rescueCounts[key]);
            sessionRescues = 0;
        }

            return { shouldAbandon, reset };
        }

        return FlightRescueRuleClass;
    }

    const FlightRescueRuleClass = makeFlightRescueRuleClass(false);
    FlightRescueRuleClass.__dashjs_factory_name = 'SafeSabrFlightRescueRule';
    const OracleFlightRescueRuleClass = makeFlightRescueRuleClass(true);
    OracleFlightRescueRuleClass.__dashjs_factory_name = 'SafeSabrOracleFlightRescueRule';
    root.SafeSabrFlightRescueRule = typeof dashjs === 'undefined'
        ? null
        : dashjs.FactoryMaker.getClassFactory(FlightRescueRuleClass);
    root.SafeSabrOracleFlightRescueRule = typeof dashjs === 'undefined'
        ? null
        : dashjs.FactoryMaker.getClassFactory(OracleFlightRescueRuleClass);
    const FlightObserverRuleClass = makeFlightRescueRuleClass(false, true);
    FlightObserverRuleClass.__dashjs_factory_name = 'SafeSabrFlightObserverRule';
    root.SafeSabrFlightObserverRule = typeof dashjs === 'undefined'
        ? null
        : dashjs.FactoryMaker.getClassFactory(FlightObserverRuleClass);
    const RiskAlignedFlightRescueRuleClass = makeFlightRescueRuleClass(false, false, true);
    RiskAlignedFlightRescueRuleClass.__dashjs_factory_name =
        'SafeSabrRiskAlignedFlightRescueRule';
    root.SafeSabrRiskAlignedFlightRescueRule = typeof dashjs === 'undefined'
        ? null
        : dashjs.FactoryMaker.getClassFactory(RiskAlignedFlightRescueRuleClass);

    function UnifiedFlightRescueRuleClass() {
        const context = this.context;
        const factory = dashjs.FactoryMaker;
        const SwitchRequest = factory.getClassFactoryByName('SwitchRequest');
        const firstSeenAt = {};
        const checkedAt = {};
        const handledChunks = {};

        function noChange() {
            return SwitchRequest(context).create();
        }

        function shouldAbandon(rulesContext) {
            const started = performance.now();
            const runtime = root.__SAFESABR_RUNTIME__;
            if (!runtime || !rulesContext || rulesContext.getMediaType() !== 'video') {
                return noChange();
            }
            const request = rulesContext.getCurrentRequest();
            if (!request || !Number.isFinite(request.index) || !request.representation) {
                return noChange();
            }
            const chunkIndex = Number(request.index);
            const currentAction = runtime.actionForBitrate(request.representation.bitrateInKbit);
            if (currentAction !== TOP_ACTION || handledChunks[chunkIndex]) {
                return noChange();
            }
            const now = performance.now();
            if (!Number.isFinite(firstSeenAt[chunkIndex])) {
                firstSeenAt[chunkIndex] = now;
            }
            const observedMs = now - firstSeenAt[chunkIndex];
            if (observedMs < MIN_OBSERVATION_MS ||
                    now - (checkedAt[chunkIndex] || 0) < CHECK_INTERVAL_MS) {
                return noChange();
            }
            checkedAt[chunkIndex] = now;
            const totalBytes = Number(request.bytesTotal || 0);
            const loadedBytes = Number(request.bytesLoaded || 0);
            const capacityKbps = recentThroughputKbps(request);
            const sizes = runtime.getChunkSizes(chunkIndex);
            const decision = evaluateUnifiedRescue({
                currentAction,
                previousAction: runtime.lastAction,
                capacityKbps,
                remainingBytes: totalBytes - loadedBytes,
                totalBytes,
                replacementBytes: Number(sizes[currentAction - 1] || 0),
                usableBufferS: Math.max(runtime.bufferSeconds() - BUFFER_GUARD_S, 0),
                bitrates: runtime.bitrates,
            });
            runtime.recordRescueDebug({
                source: 'SafeSABR-Unified-Flight-Rescue',
                chunkIndex,
                currentAction,
                observedMs,
                loadedBytes,
                totalBytes,
                capacityKbps,
                ...decision,
            });
            if (!decision.rescue) {
                return noChange();
            }
            const abrController = rulesContext.getAbrController();
            const mediaInfo = rulesContext.getMediaInfo();
            const representation = abrController.getOptimalRepresentationForBitrate(
                mediaInfo,
                runtime.bitrates[decision.rescueAction],
                true
            );
            if (!representation || representation.bitrateInKbit >= request.representation.bitrateInKbit) {
                return noChange();
            }
            const switchRequest = SwitchRequest(context).create();
            switchRequest.representation = representation;
            switchRequest.priority = SwitchRequest.PRIORITY.STRONG;
            switchRequest.reason = {
                source: 'SafeSABR-Unified-Flight-Rescue',
                chunkIndex,
                currentAction,
                capacityKbps,
                ...decision,
            };
            handledChunks[chunkIndex] = true;
            runtime.forceRescue(chunkIndex, decision.rescueAction, capacityKbps);
            runtime.recordRescue({
                ...switchRequest.reason,
                bytesLoaded: loadedBytes,
                bytesTotal: totalBytes,
                observedMs,
            }, performance.now() - started);
            return switchRequest;
        }

        function reset() {
            Object.keys(firstSeenAt).forEach((key) => delete firstSeenAt[key]);
            Object.keys(checkedAt).forEach((key) => delete checkedAt[key]);
            Object.keys(handledChunks).forEach((key) => delete handledChunks[key]);
        }

        return { shouldAbandon, reset };
    }

    UnifiedFlightRescueRuleClass.__dashjs_factory_name = 'SafeSabrUnifiedFlightRescueRule';
    root.SafeSabrUnifiedFlightRescueRule = typeof dashjs === 'undefined'
        ? null
        : dashjs.FactoryMaker.getClassFactory(UnifiedFlightRescueRuleClass);
    root.evaluateSafeSabrUnifiedRescue = evaluateUnifiedRescue;

    function FlightProbeRuleClass() {
        const context = this.context;
        const factory = dashjs.FactoryMaker;
        const SwitchRequest = factory.getClassFactoryByName('SwitchRequest');
        const firstSeenAt = {};
        const handledChunks = {};

        function noChange() {
            return SwitchRequest(context).create();
        }

        function shouldAbandon(rulesContext) {
            const runtime = root.__SAFESABR_RUNTIME__;
            if (!runtime || !rulesContext || rulesContext.getMediaType() !== 'video') {
                return noChange();
            }
            const request = rulesContext.getCurrentRequest();
            if (!request || !Number.isFinite(request.index) || !request.representation) {
                return noChange();
            }
            const chunkIndex = Number(request.index);
            const currentAction = runtime.actionForBitrate(request.representation.bitrateInKbit);
            if (chunkIndex !== runtime.probeRescueChunk ||
                    currentAction <= runtime.probeRescueAction || handledChunks[chunkIndex]) {
                return noChange();
            }
            const now = performance.now();
            if (!Number.isFinite(firstSeenAt[chunkIndex])) {
                firstSeenAt[chunkIndex] = now;
            }
            const observedMs = now - firstSeenAt[chunkIndex];
            if (observedMs < runtime.probeRescueAfterMs) {
                return noChange();
            }
            const abrController = rulesContext.getAbrController();
            const mediaInfo = rulesContext.getMediaInfo();
            const representation = abrController.getOptimalRepresentationForBitrate(
                mediaInfo,
                runtime.bitrates[runtime.probeRescueAction],
                true
            );
            if (!representation || representation.bitrateInKbit >= request.representation.bitrateInKbit) {
                return noChange();
            }
            const switchRequest = SwitchRequest(context).create();
            switchRequest.representation = representation;
            switchRequest.priority = SwitchRequest.PRIORITY.STRONG;
            switchRequest.reason = {
                source: 'SafeSABR-Controlled-Flight-Probe',
                chunkIndex,
                currentAction,
                rescueAction: runtime.probeRescueAction,
                observedMs,
            };
            handledChunks[chunkIndex] = true;
            runtime.forceRescue(chunkIndex, runtime.probeRescueAction, NaN);
            runtime.recordRescue({
                ...switchRequest.reason,
                bytesLoaded: Number(request.bytesLoaded || 0),
                bytesTotal: Number(request.bytesTotal || 0),
                bufferS: runtime.bufferSeconds(),
            }, 0);
            return switchRequest;
        }

        function reset() {
            Object.keys(firstSeenAt).forEach((key) => delete firstSeenAt[key]);
            Object.keys(handledChunks).forEach((key) => delete handledChunks[key]);
        }

        return { shouldAbandon, reset };
    }

    FlightProbeRuleClass.__dashjs_factory_name = 'SafeSabrFlightProbeRule';
    root.SafeSabrFlightProbeRule = typeof dashjs === 'undefined'
        ? null
        : dashjs.FactoryMaker.getClassFactory(FlightProbeRuleClass);
})(typeof window === 'undefined' ? globalThis : window);
