(async function () {
    'use strict';

    const params = new URLSearchParams(window.location.search);
    const method = params.get('method') || 'dash_dynamic';
    const mpdUrl = params.get('mpd') || 'http://media:8080/video/stream.mpd';
    const shaperStartUrl = params.get('shaper') || 'http://media:8081/start';
    const sessionId = params.get('session') || 'manual';
    const traceId = params.get('trace_id') || 'smoke.trace';
    const traceStartSecond = Number(params.get('start_second') || 0);
    const policySeed = Number(params.get('seed') || 42);
    const policyAsset = params.get('policy_asset') || 'safesabr_seed42.json';
    const riskThresholdParam = params.get('risk_threshold');
    const riskThreshold = riskThresholdParam === null || riskThresholdParam === ''
        ? NaN
        : Number(riskThresholdParam);
    const stopAfterMediaS = Math.max(Number(params.get('stop_after_media_s') || 0), 0);
    const maxScreeningRebufferS = Math.max(
        Number(params.get('max_screening_rebuffer_s') || 0),
        0
    );
    const probeChunk = Number(params.get('probe_chunk') || -1);
    const probeAction = Number(params.get('probe_action') || -1);
    const probeRescueChunk = Number(params.get('probe_rescue_chunk') || -1);
    const probeRescueAction = Number(params.get('probe_rescue_action') || -1);
    const probeRescueAfterMs = Number(params.get('probe_rescue_after_ms') || 500);
    const bufferTimeDefaultS = Math.max(Number(params.get('buffer_time_default_s') || 60), 4);
    const bufferTimeTopS = Math.max(Number(params.get('buffer_time_top_s') || 60), 4);
    const bufferTimeTopLongS = Math.max(Number(params.get('buffer_time_top_long_s') || 60), 4);
    const bufferToKeepS = Math.max(Number(params.get('buffer_to_keep_s') || 20), 0);
    const bufferPruningIntervalS = Math.max(
        Number(params.get('buffer_pruning_interval_s') || 10),
        0.1
    );
    const status = document.getElementById('status');
    const video = document.getElementById('video');
    const initializedAt = performance.now();
    const initializedEpochMs = Date.now();
    const experiment = {
        schema: 5,
        method,
        session_id: sessionId,
        trace_id: traceId,
        policy_asset: policyAsset,
        trace_start_second: traceStartSecond,
        screening_stop_media_s: stopAfterMediaS || null,
        screening_max_rebuffer_s: maxScreeningRebufferS || null,
        screening_stop_reason: null,
        causal_probe: probeChunk >= 0 && probeAction >= 0
            ? { chunk: probeChunk, action: probeAction }
            : null,
        flight_probe: probeRescueChunk >= 0 && probeRescueAction >= 0
            ? {
                chunk: probeRescueChunk,
                action: probeRescueAction,
                after_ms: probeRescueAfterMs,
            }
            : null,
        dashjs_version: dashjs.Version,
        mpd_url: mpdUrl,
        started_at: new Date().toISOString(),
        chunks: [],
        request_starts: [],
        request_events: [],
        appended_chunks: [],
        unmatched_appends: [],
        quality_change_requests: [],
        quality_changes: [],
        buffer_events: [],
        stalls: [],
        playback_events: [],
        abandoned_requests: [],
        failed_requests: [],
        errors: [],
        samples: [],
        clock_origin_ms: initializedAt,
        clock_origin_epoch_ms: initializedEpochMs,
    };
    window.__SAFESABR_EXPERIMENT__ = experiment;
    window.__SAFESABR_RESULT__ = null;

    let playbackStarted = false;
    let stallStartedAt = null;
    let sampleTimer = null;
    let finalized = false;
    let player;
    const completedRequestByRepresentation = new Map();
    const appendedVideoIndexes = new Set();
    const requestIds = new WeakMap();
    let nextRequestId = 1;

    function representationKey(index, representationId) {
        return `${index}:${representationId || ''}`;
    }

    function requestId(request) {
        if (!request || (typeof request !== 'object' && typeof request !== 'function')) {
            return null;
        }
        if (!requestIds.has(request)) {
            requestIds.set(request, nextRequestId);
            nextRequestId += 1;
        }
        return requestIds.get(request);
    }

    function requestSnapshot(request) {
        if (!request) {
            return {};
        }
        const timestampMs = (value) => {
            if (!value) {
                return null;
            }
            const epochMs = typeof value.getTime === 'function'
                ? value.getTime()
                : Date.parse(value);
            return Number.isFinite(epochMs) ? epochMs - initializedEpochMs : null;
        };
        const requestAtMs = timestampMs(request.trequest);
        const responseAtMs = timestampMs(request.tresponse);
        const finishAtMs = timestampMs(request.tfinish);
        const timestampDurationMs = Number.isFinite(requestAtMs) && Number.isFinite(finishAtMs)
            ? Math.max(finishAtMs - requestAtMs, 0)
            : null;
        const traceDurationMs = Array.isArray(request.traces)
            ? Math.max(
                request.traces.reduce((sum, trace) => sum + Number(trace.d || 0), 0),
                0
            )
            : null;
        return {
            request_id: requestId(request),
            index: Number.isFinite(request.index) ? request.index : null,
            type: request.type || null,
            media_type: request.mediaType || null,
            bytes_loaded: Number(request.bytesLoaded || 0),
            bytes_total: Number(request.bytesTotal || 0),
            bitrate_kbps: request.representation ? Number(request.representation.bitrateInKbit) : null,
            representation_id: request.representation ? request.representation.id : null,
            start_time_s: Number.isFinite(request.startTime) ? Number(request.startTime) : null,
            duration_s: Number.isFinite(request.duration) ? Number(request.duration) : null,
            url: request.url || null,
            request_at_ms: requestAtMs,
            response_at_ms: responseAtMs,
            finish_at_ms: finishAtMs,
            request_duration_ms: timestampDurationMs,
            trace_duration_ms: traceDurationMs,
            controller_observed_request_duration_ms: Number.isFinite(timestampDurationMs)
                ? Math.max(timestampDurationMs, 1)
                : Number.isFinite(traceDurationMs)
                    ? Math.max(traceDurationMs, 1)
                    : 1,
            response_delay_ms: Number.isFinite(requestAtMs) && Number.isFinite(responseAtMs)
                ? Math.max(responseAtMs - requestAtMs, 0)
                : null,
        };
    }

    function isVideoSegment(request) {
        return request && request.mediaType === 'video' && request.type === 'MediaSegment';
    }

    function isVideoRequest(request) {
        return request && request.mediaType === 'video';
    }

    function recordRequestEvent(phase, request, extra = {}) {
        if (!isVideoRequest(request)) {
            return;
        }
        experiment.request_events.push({
            phase,
            ...requestSnapshot(request),
            observed_at_ms: performance.now() - initializedAt,
            buffer_s: player ? player.getBufferLength('video') || 0 : 0,
            media_time_s: video.currentTime,
            ...extra,
        });
    }

    function finishStall() {
        if (stallStartedAt === null) {
            return;
        }
        const endedAt = performance.now();
        experiment.stalls.push({
            started_ms: stallStartedAt - initializedAt,
            duration_s: (endedAt - stallStartedAt) / 1000,
            media_time_s: video.currentTime,
        });
        stallStartedAt = null;
        const runtime = window.__ABR_RUNTIME__;
        if (runtime) {
            runtime.sessionRebufferSeconds = experiment.stalls.reduce(
                (sum, stall) => sum + stall.duration_s,
                0
            );
        }
    }

    function percentile(values, q) {
        if (!values.length) {
            return 0;
        }
        const sorted = values.slice().sort((a, b) => a - b);
        const index = Math.min(Math.floor(q * sorted.length), sorted.length - 1);
        return sorted[index];
    }

    function renderedChunkBitrates() {
        const chunkCount = Math.max(Math.round(video.currentTime / 4), 0);
        const changes = experiment.quality_changes
            .filter((change) => Number.isFinite(change.new_bitrate_kbps))
            .sort((left, right) => left.media_time_s - right.media_time_s);
        if (!chunkCount || !changes.length) {
            return [];
        }
        const bitrates = [];
        let changeIndex = 0;
        let bitrate = changes[0].new_bitrate_kbps;
        for (let chunk = 0; chunk < chunkCount; chunk += 1) {
            const midpoint = chunk * 4 + 2;
            while (changeIndex + 1 < changes.length &&
                    changes[changeIndex + 1].media_time_s <= midpoint) {
                changeIndex += 1;
                bitrate = changes[changeIndex].new_bitrate_kbps;
            }
            bitrates.push(bitrate / 1000);
        }
        return bitrates;
    }

    function currentBitrateKbps() {
        try {
            const representation = player.getCurrentRepresentationForType('video');
            return representation ? Number(representation.bitrateInKbit) : null;
        } catch (_error) {
            return null;
        }
    }

    function disableDashQualityRules() {
        const useSafeSabrDeadline = ['safesabr', 'safesabr_stateful'].includes(method);
        player.updateSettings({
            streaming: {
                // V4 resumes normal policy control after the lower-bitrate
                // replacement has had time to start, instead of retaining
                // dash.js's conservative 10 s post-abandonment lock.
                abandonLoadTimeout: 1000,
                fragmentRequestTimeout: useSafeSabrDeadline ? 4000 : 20000,
                retryAttempts: {
                    MediaSegment: useSafeSabrDeadline ? 0 : 3,
                },
                abr: {
                    initialBitrate: { video: 8000 },
                    rules: {
                        throughputRule: { active: false },
                        bolaRule: { active: false },
                        insufficientBufferRule: { active: false },
                        switchHistoryRule: { active: false },
                        droppedFramesRule: { active: false },
                        abandonRequestsRule: { active: false },
                    },
                },
            },
        });
    }

    function applyTimeoutRescue(request, source) {
        const runtime = window.__SAFESABR_RUNTIME__;
        if (!runtime || !['safesabr', 'safesabr_stateful'].includes(method) ||
                !isVideoSegment(request) ||
                !Number.isFinite(request.index) || !request.representation) {
            return;
        }
        const currentAction = runtime.actionForBitrate(request.representation.bitrateInKbit);
        if (currentAction <= 0) {
            return;
        }
        const rescueAction = currentAction - 1;
        const pending = runtime.pendingRescue;
        if (pending && pending.chunkIndex === Number(request.index) &&
                pending.action <= rescueAction) {
            return;
        }
        const capacityKbps = runtime.safeTransferCapacityKbps();
        runtime.forceRescue(request.index, rescueAction, capacityKbps);
        runtime.recordRescue({
            source,
            chunkIndex: Number(request.index),
            currentAction,
            rescueAction,
            capacityKbps,
            bytesLoaded: Number(request.bytesLoaded || 0),
            bytesTotal: Number(request.bytesTotal || 0),
        }, 0);
    }

    function finalize() {
        if (finalized) {
            return;
        }
        finalized = true;

        const remainingS = Number.isFinite(video.duration)
            ? Math.max(video.duration - video.currentTime, 0)
            : Infinity;
        // Chromium can stop one floating-point tick before duration without
        // emitting `ended`. Do not count that terminal state as rebuffering.
        if (remainingS > 0.1) {
            finishStall();
        } else {
            stallStartedAt = null;
        }
        if (sampleTimer !== null) {
            clearInterval(sampleTimer);
        }
        const bitratesMbps = renderedChunkBitrates();
        experiment.played_bitrates_mbps = bitratesMbps;
        const totalRebufferS = experiment.stalls.reduce((sum, stall) => sum + stall.duration_s, 0);
        const switchPenalty = bitratesMbps.slice(1).reduce(
            (sum, bitrate, index) => sum + Math.abs(bitrate - bitratesMbps[index]),
            0
        );
        const completedBytes = experiment.chunks.reduce((sum, chunk) => sum + chunk.bytes_loaded, 0);
        const abandonedBytes = experiment.abandoned_requests.reduce(
            (sum, request) => sum + request.bytes_loaded,
            0
        );
        const failedBytes = experiment.failed_requests.reduce(
            (sum, request) => sum + request.bytes_loaded,
            0
        );
        const runtime = window.__ABR_RUNTIME__;
        const policyDecisionMs = runtime ? runtime.policyDecisionMs : [];
        const rescueDecisionMs = runtime ? runtime.rescueDecisionMs : [];
        window.__SAFESABR_RESULT__ = {
            ...experiment,
            finished_at: new Date().toISOString(),
            metrics: {
                completed_chunks: bitratesMbps.length,
                playback_duration_s: video.currentTime,
                wall_clock_s: (performance.now() - initializedAt) / 1000,
                startup_delay_s: experiment.playback_started_ms / 1000,
                average_bitrate_mbps: bitratesMbps.length
                    ? bitratesMbps.reduce((sum, value) => sum + value, 0) / bitratesMbps.length
                    : 0,
                total_rebuffer_s: totalRebufferS,
                severe_session: totalRebufferS > 10,
                smoothness_penalty_mbps: switchPenalty,
                qoe: bitratesMbps.reduce((sum, value) => sum + value, 0) -
                    40 * totalRebufferS - switchPenalty,
                abandoned_requests: experiment.abandoned_requests.length +
                    experiment.failed_requests.length,
                wasted_bytes: abandonedBytes + failedBytes,
                wasted_traffic_ratio: completedBytes + abandonedBytes + failedBytes > 0
                    ? (abandonedBytes + failedBytes) /
                        (completedBytes + abandonedBytes + failedBytes)
                    : 0,
                rescue_decisions: runtime ? runtime.rescueDecisions.length : 0,
                recovery_episodes: runtime && Number.isFinite(runtime.recoveryEpisodes)
                    ? runtime.recoveryEpisodes
                    : 0,
                recovery_capped_decisions: runtime && Number.isFinite(runtime.recoveryCappedDecisions)
                    ? runtime.recoveryCappedDecisions
                    : 0,
                preflight_capped_decisions: runtime && Number.isFinite(runtime.preflightCappedDecisions)
                    ? runtime.preflightCappedDecisions
                    : 0,
                handover_capped_decisions: runtime && Number.isFinite(runtime.handoverCappedDecisions)
                    ? runtime.handoverCappedDecisions
                    : 0,
                risk_gate_capped_decisions: runtime && Number.isFinite(runtime.riskGateCappedDecisions)
                    ? runtime.riskGateCappedDecisions
                    : 0,
                policy_decision_mean_ms: policyDecisionMs.length
                    ? policyDecisionMs.reduce((sum, value) => sum + value, 0) / policyDecisionMs.length
                    : 0,
                policy_decision_p95_ms: percentile(policyDecisionMs, 0.95),
                rescue_decision_mean_ms: rescueDecisionMs.length
                    ? rescueDecisionMs.reduce((sum, value) => sum + value, 0) / rescueDecisionMs.length
                    : 0,
                rescue_decision_p95_ms: percentile(rescueDecisionMs, 0.95),
            },
            rescue_log: runtime ? runtime.rescueDecisions : [],
            rescue_debug: runtime && runtime.rescueDebug ? runtime.rescueDebug : [],
            rescue_rule_diagnostic: window.__SAFESABR_RESCUE_DIAG__ || null,
            decision_log: runtime && runtime.decisionLog ? runtime.decisionLog : [],
        };
        status.textContent = 'complete';
    }

    function finalizeNearMediaEnd() {
        if (finalized || !Number.isFinite(video.duration) || video.duration <= 0) {
            return;
        }
        const expectedChunks = Math.ceil((video.duration - 0.1) / 4);
        if (video.duration - video.currentTime <= 0.1 &&
                appendedVideoIndexes.size >= expectedChunks) {
            finalize();
        }
    }

    function finalizeAtScreeningBoundary() {
        if (!finalized && stopAfterMediaS > 0 && video.currentTime >= stopAfterMediaS - 0.05) {
            experiment.screening_stop_reason = 'media-time-boundary';
            finalize();
            return;
        }
        const completedRebufferS = experiment.stalls.reduce(
            (sum, stall) => sum + stall.duration_s,
            0
        );
        const activeRebufferS = stallStartedAt === null
            ? 0
            : (performance.now() - stallStartedAt) / 1000;
        if (!finalized && maxScreeningRebufferS > 0 &&
                completedRebufferS + activeRebufferS >= maxScreeningRebufferS) {
            experiment.screening_stop_reason = 'rebuffer-limit';
            finalize();
        }
    }

    try {
        player = dashjs.MediaPlayer().create();
        player.updateSettings({
            streaming: {
                buffer: {
                    fastSwitchEnabled: false,
                    bufferTimeDefault: bufferTimeDefaultS,
                    bufferTimeAtTopQuality: bufferTimeTopS,
                    bufferTimeAtTopQualityLongForm: bufferTimeTopLongS,
                    bufferToKeep: bufferToKeepS,
                    bufferPruningInterval: bufferPruningIntervalS,
                },
            },
        });
        if (['safesabr', 'safesabr_no_rescue', 'safesabr_admission6',
                'safesabr_admission8', 'safesabr_admission10', 'safesabr_admission12',
                'safesabr_admission16', 'safesabr_admission20', 'safesabr_flight_observer',
                'safesabr_flight_probe', 'safesabr_oracle_rescue',
                'safesabr_oracle_launch', 'safesabr_oracle_value',
                'safesabr_oracle_combined',
                'safesabr_stateful_no_rescue', 'safesabr_stateful',
                'safesabr_unified_no_rescue', 'safesabr_unified',
                'safesabr_selective', 'safesabr_selective_basic_rescue',
                'safesabr_selective_rescue',
                'fixed_60', 'fixed_120', 'fixed_alternating',
                'fixed_low_cycle', 'fixed_low_support_cycle',
                'fixed_transition_cycle',
                'fixed_top_transition_cycle'].includes(method)) {
            if (!/^[A-Za-z0-9._-]+\.json$/.test(policyAsset)) {
                throw new Error(`invalid SafeSABR policy asset: ${policyAsset}`);
            }
            const [modelResponse, chunksResponse, riskResponse] = await Promise.all([
                fetch(`/assets/${encodeURIComponent(policyAsset)}`),
                fetch('/assets/chunk_sizes.json'),
                method.startsWith('safesabr_selective')
                    ? fetch('/assets/safesabr_risk_critic.json')
                    : Promise.resolve(null),
            ]);
            if (!modelResponse.ok || !chunksResponse.ok ||
                    (riskResponse && !riskResponse.ok)) {
                throw new Error('SafeSABR policy or chunk metadata is unavailable');
            }
            const model = await modelResponse.json();
            const chunks = await chunksResponse.json();
            const riskCritic = riskResponse ? await riskResponse.json() : null;
            window.__SAFESABR_RUNTIME__ = new SafeSabrRuntime(player, model, chunks, {
                executionMode: method.startsWith('safesabr_unified')
                    ? 'unified'
                    : method.startsWith('safesabr_stateful')
                    ? 'stateful'
                    : method.startsWith('safesabr_admission')
                    ? 'admission'
                    : method.startsWith('safesabr_selective') ? 'selective' : 'policy',
                riskCritic,
                riskThreshold,
                admissionBufferSeconds: method.startsWith('safesabr_admission')
                    ? Number(method.replace('safesabr_admission', ''))
                    : 16,
                startSecond: traceStartSecond,
                probeChunk,
                probeAction,
                probeRescueChunk,
                probeRescueAction,
                probeRescueAfterMs,
                fixedActionSequence: method === 'fixed_60'
                    ? [4]
                    : method === 'fixed_120'
                    ? [5]
                    : method === 'fixed_alternating'
                    ? [4, 5]
                    : method === 'fixed_low_cycle'
                    ? [0, 0, 1, 1, 2, 2, 3, 3, 2, 2, 1, 1]
                    : method === 'fixed_low_support_cycle'
                    ? [0, 1, 2, 3, 2, 2, 1, 0]
                    : method === 'fixed_transition_cycle'
                    ? [0, 0, 3, 3, 4, 3, 4, 3, 4, 3, 2, 1, 0]
                    : method === 'fixed_top_transition_cycle'
                    ? [3, 4, 5, 4]
                    : null,
            });
            window.__ABR_RUNTIME__ = window.__SAFESABR_RUNTIME__;
            disableDashQualityRules();
            player.addABRCustomRule('qualitySwitchRules', 'SafeSabrQualityRule', SafeSabrQualityRule);
            if (method === 'safesabr') {
                player.addABRCustomRule(
                    'abandonFragmentRules',
                    'SafeSabrFlightRescueRule',
                    SafeSabrFlightRescueRule
                );
            } else if (method === 'safesabr_flight_observer') {
                player.addABRCustomRule(
                    'abandonFragmentRules',
                    'SafeSabrFlightObserverRule',
                    SafeSabrFlightObserverRule
                );
            } else if (method === 'safesabr_flight_probe') {
                player.addABRCustomRule(
                    'abandonFragmentRules',
                    'SafeSabrFlightProbeRule',
                    SafeSabrFlightProbeRule
                );
            } else if (method === 'safesabr_stateful') {
                player.addABRCustomRule(
                    'abandonFragmentRules',
                    'SafeSabrFlightRescueRule',
                    SafeSabrFlightRescueRule
                );
            } else if (method === 'safesabr_unified') {
                player.addABRCustomRule(
                    'abandonFragmentRules',
                    'SafeSabrUnifiedFlightRescueRule',
                    SafeSabrUnifiedFlightRescueRule
                );
            } else if (method === 'safesabr_selective_rescue') {
                player.addABRCustomRule(
                    'abandonFragmentRules',
                    'SafeSabrRiskAlignedFlightRescueRule',
                    SafeSabrRiskAlignedFlightRescueRule
                );
            } else if (method === 'safesabr_selective_basic_rescue') {
                player.addABRCustomRule(
                    'abandonFragmentRules',
                    'SafeSabrFlightRescueRule',
                    SafeSabrFlightRescueRule
                );
            } else if (['safesabr_oracle_rescue', 'safesabr_oracle_combined'].includes(method)) {
                player.addABRCustomRule(
                    'abandonFragmentRules',
                    'SafeSabrOracleFlightRescueRule',
                    SafeSabrOracleFlightRescueRule
                );
            }
        } else if (['robust_mpc', 'sara', 'cmab', 'starnet_mpc',
                'lumos_mpc', 'wabb'].includes(method)) {
            const needsExternalInputs = ['starnet_mpc', 'lumos_mpc', 'wabb'].includes(method);
            const [chunksResponse, externalResponse] = await Promise.all([
                fetch('/assets/chunk_sizes.json'),
                needsExternalInputs
                    ? fetch('/assets/external_baselines.json')
                    : Promise.resolve(null),
            ]);
            if (!chunksResponse.ok || (externalResponse && !externalResponse.ok)) {
                throw new Error('baseline chunk metadata or external inputs are unavailable');
            }
            const chunks = await chunksResponse.json();
            const externalBaselines = externalResponse ? await externalResponse.json() : null;
            window.__ABR_RUNTIME__ = new BaselineAbrRuntime(player, chunks, method, {
                startSecond: traceStartSecond,
                seed: policySeed,
                traceId,
                externalBaselines,
            });
            disableDashQualityRules();
            player.addABRCustomRule('qualitySwitchRules', 'BaselineQualityRule', BaselineQualityRule);
        } else if (method === 'dash_dynamic') {
            player.updateSettings({
                streaming: {
                    abr: {
                        rules: {
                            throughputRule: { active: true },
                            bolaRule: { active: true },
                            abandonRequestsRule: { active: true },
                        },
                    },
                },
            });
        } else {
            throw new Error(`unsupported method: ${method}`);
        }

        const events = dashjs.MediaPlayer.events;
        // Measure user-visible stalls from the media element itself. dash.js
        // buffer events are useful diagnostics but are not a playback clock.
        video.addEventListener('playing', () => {
            if (!playbackStarted) {
                playbackStarted = true;
                experiment.playback_started_ms = performance.now() - initializedAt;
            }
            finishStall();
        });
        video.addEventListener('waiting', () => {
            if (playbackStarted && stallStartedAt === null) {
                stallStartedAt = performance.now();
            }
        });
        player.on(events.FRAGMENT_LOADING_STARTED, (event) => {
            const request = event.request;
            recordRequestEvent('loading_started', request);
            if (!isVideoSegment(request)) {
                return;
            }
            experiment.request_starts.push({
                ...requestSnapshot(request),
                observed_at_ms: performance.now() - initializedAt,
                buffer_s: player.getBufferLength('video') || 0,
                media_time_s: video.currentTime,
            });
            const runtime = window.__ABR_RUNTIME__;
            if (runtime && typeof runtime.observeRequestStart === 'function') {
                runtime.observeRequestStart(request, player.getBufferLength('video') || 0);
            }
        });
        player.on(events.QUALITY_CHANGE_REQUESTED, (event) => {
            if (event.mediaType !== 'video') {
                return;
            }
            experiment.quality_change_requests.push({
                at_ms: performance.now() - initializedAt,
                media_time_s: video.currentTime,
                buffer_s: player.getBufferLength('video') || 0,
                old_bitrate_kbps: event.oldRepresentation
                    ? event.oldRepresentation.bitrateInKbit
                    : null,
                new_bitrate_kbps: event.newRepresentation
                    ? event.newRepresentation.bitrateInKbit
                    : null,
                reason: event.reason
                    ? String(event.reason.name || event.reason.rule || event.reason)
                    : null,
            });
        });
        player.on(events.QUALITY_CHANGE_RENDERED, (event) => {
            if (event.mediaType === 'video') {
                experiment.quality_changes.push({
                    at_ms: performance.now() - initializedAt,
                    media_time_s: video.currentTime,
                    old_bitrate_kbps: event.oldRepresentation ? event.oldRepresentation.bitrateInKbit : null,
                    new_bitrate_kbps: event.newRepresentation ? event.newRepresentation.bitrateInKbit : null,
                });
            }
        });
        player.on(events.FRAGMENT_LOADING_COMPLETED, (event) => {
            const request = event.request;
            recordRequestEvent('loading_completed', request, {
                error: event.error ? String(event.error) : null,
            });
            if (!isVideoSegment(request)) {
                return;
            }
            const snapshot = requestSnapshot(request);
            snapshot.completed_at_ms = performance.now() - initializedAt;
            if (event.error) {
                snapshot.error = String(event.error);
                experiment.failed_requests.push(snapshot);
                applyTimeoutRescue(request, 'SafeSABR-Deadline-Rescue');
                return;
            }
            experiment.chunks.push(snapshot);
            const representationId = request.representation ? request.representation.id : null;
            const key = representationKey(request.index, representationId);
            // A later request for the same segment may be a browser-cache read.
            // Keep the first successful transfer as the policy's network feedback.
            if (!completedRequestByRepresentation.has(key)) {
                completedRequestByRepresentation.set(key, request);
            }
        });
        player.on('bytesAppendedEndFragment', (event) => {
            if (event.mediaType !== 'video' || event.segmentType !== 'MediaSegment' ||
                    !Number.isFinite(event.index)) {
                return;
            }
            const duplicateIndex = appendedVideoIndexes.has(event.index);
            const request = completedRequestByRepresentation.get(
                representationKey(event.index, event.representationId)
            );
            const runtime = window.__ABR_RUNTIME__;
            experiment.appended_chunks.push({
                ...(request ? requestSnapshot(request) : {}),
                index: Number(event.index),
                representation_id: event.representationId || null,
                appended_at_ms: performance.now() - initializedAt,
                buffer_s_before_callback: player.getBufferLength('video') || 0,
                media_time_s: video.currentTime,
                duplicate_index: duplicateIndex,
                matched_request: Boolean(request),
            });
            if (!request) {
                experiment.unmatched_appends.push({
                    index: Number(event.index),
                    representation_id: event.representationId || null,
                    appended_at_ms: performance.now() - initializedAt,
                });
            }
            if (!duplicateIndex) {
                appendedVideoIndexes.add(event.index);
                if (request && runtime) {
                    runtime.completeChunk(request, runtime.bufferSeconds());
                }
            }
        });
        player.on(events.FRAGMENT_LOADING_ABANDONED, (event) => {
            const request = event.request;
            recordRequestEvent('loading_abandoned', request);
            if (isVideoSegment(request)) {
                const snapshot = requestSnapshot(request);
                snapshot.abandoned_at_ms = performance.now() - initializedAt;
                experiment.abandoned_requests.push(snapshot);
                applyTimeoutRescue(request, 'SafeSABR-No-Progress-Rescue');
            }
        });
        player.on(events.BUFFER_LEVEL_UPDATED, (event) => {
            if (event.mediaType !== 'video') {
                return;
            }
            experiment.buffer_events.push({
                at_ms: performance.now() - initializedAt,
                media_time_s: video.currentTime,
                buffer_s: Number.isFinite(event.bufferLevel)
                    ? Number(event.bufferLevel)
                    : player.getBufferLength('video') || 0,
            });
        });
        player.on(events.ERROR, (event) => {
            experiment.errors.push({ at_ms: performance.now() - initializedAt, event: String(event && event.error || event) });
        });
        player.on(events.PLAYBACK_ENDED, finalize);
        ['pause', 'stalled', 'suspend', 'seeking', 'seeked'].forEach((eventName) => {
            video.addEventListener(eventName, () => {
                experiment.playback_events.push({
                    at_ms: performance.now() - initializedAt,
                    event: eventName,
                    media_time_s: video.currentTime,
                    buffer_s: player.getBufferLength('video') || 0,
                });
            });
        });

        status.textContent = `starting ${method}`;
        const startResponse = await fetch(shaperStartUrl);
        if (!startResponse.ok) {
            throw new Error(`unable to start trace replay: HTTP ${startResponse.status}`);
        }
        const startPayload = await startResponse.json();
        if (window.__SAFESABR_RUNTIME__ && method.startsWith('safesabr_oracle_')) {
            window.__SAFESABR_RUNTIME__.setOracleTrace(startPayload.trace_points);
            if (['safesabr_oracle_launch', 'safesabr_oracle_combined'].includes(method)) {
                window.__SAFESABR_RUNTIME__.enableOracleLaunchProjection();
            } else if (method === 'safesabr_oracle_value') {
                window.__SAFESABR_RUNTIME__.enableOracleValueProjection();
            }
        }
        if (window.__ABR_RUNTIME__) {
            window.__ABR_RUNTIME__.traceStartedAt = performance.now();
            experiment.trace_started_at_ms = performance.now() - initializedAt;
        }
        player.initialize(video, mpdUrl, true);
        const configuredBuffer = player.getSettings().streaming.buffer;
        const configuredRules = player.getSettings().streaming.abr.rules;
        experiment.player_settings = {
            buffer_time_default_s: configuredBuffer.bufferTimeDefault,
            buffer_time_top_quality_s: configuredBuffer.bufferTimeAtTopQuality,
            buffer_time_top_quality_long_form_s: configuredBuffer.bufferTimeAtTopQualityLongForm,
            buffer_to_keep_s: configuredBuffer.bufferToKeep,
            buffer_pruning_interval_s: configuredBuffer.bufferPruningInterval,
            schedule_while_paused: player.getSettings().streaming.scheduling.scheduleWhilePaused,
            throughput_rule_active: configuredRules.throughputRule.active,
            bola_rule_active: configuredRules.bolaRule.active,
            insufficient_buffer_rule_active: configuredRules.insufficientBufferRule.active,
            switch_history_rule_active: configuredRules.switchHistoryRule.active,
            abandon_requests_rule_active: configuredRules.abandonRequestsRule.active,
        };
        sampleTimer = setInterval(() => {
            experiment.samples.push({
                at_ms: performance.now() - initializedAt,
                media_time_s: video.currentTime,
                buffer_s: player.getBufferLength('video') || 0,
                bitrate_kbps: currentBitrateKbps(),
                paused: video.paused,
                ready_state: video.readyState,
                network_state: video.networkState,
            });
            finalizeAtScreeningBoundary();
            finalizeNearMediaEnd();
        }, 250);
    } catch (error) {
        experiment.errors.push({ at_ms: performance.now() - initializedAt, event: String(error.stack || error) });
        status.textContent = 'failed';
        window.__SAFESABR_RESULT__ = { ...experiment, fatal_error: String(error.stack || error) };
    }
})();
