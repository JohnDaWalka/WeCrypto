/**
 * ================================================================
 * Async Refresh Engine — Event-Driven Real-Time Updates
 * 
 * Replaces interval-based polling with continuous async streams.
 * Multiple data flows run in parallel without blocking the UI.
 * 
 * Architecture:
 * - AsyncRefreshEngine: Main orchestrator
 * - DataStreams: Independent async generators for each data type
 * - EventBus: Broadcasts updates to UI subscribers
 * - Priority Queue: Prioritizes urgent updates (settlements, alerts)
 * 
 * Benefits:
 * ✓ Predictions run every 30s in background (non-blocking)
 * ✓ Kalshi balance updates every 5s
 * ✓ Market data updates on settlement boundaries
 * ✓ UI never waits for data — updates push in
 * ✓ Graceful degradation if any source fails
 * ================================================================
 */

(function () {
    'use strict';

    class EventBus {
        constructor() {
            this.subscribers = new Map();
        }

        on(event, callback) {
            if (!this.subscribers.has(event)) {
                this.subscribers.set(event, []);
            }
            this.subscribers.get(event).push(callback);
            return () => {
                const idx = this.subscribers.get(event).indexOf(callback);
                if (idx > -1) this.subscribers.get(event).splice(idx, 1);
            };
        }

        emit(event, data) {
            if (!this.subscribers.has(event)) return;
            for (const cb of this.subscribers.get(event)) {
                try { cb(data); } catch (e) {
                    console.error(`[EventBus] ${event} handler error:`, e.message);
                }
            }
        }

        once(event, callback) {
            const unsub = this.on(event, (data) => {
                unsub();
                callback(data);
            });
            return unsub;
        }
    }

    class AsyncRefreshEngine {
        constructor() {
            this.bus = new EventBus();
            this.running = false;
            this.streams = new Map();
            this.clockOffsetMs = 0;
            this.clockSource = 'system';
            this.clockSyncedAt = 0;
            this.clockSyncInFlight = null;
            this.clockResyncIntervalMs = 15 * 60 * 1000;
            this.etFormatter = new Intl.DateTimeFormat('en-US', {
                timeZone: 'America/New_York',
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: false,
                timeZoneName: 'short'
            });
            this.timeSyncSources = [
                {
                    name: 'timeapi.io/america-new_york',
                    url: 'https://timeapi.io/api/Time/current/zone?timeZone=America/New_York',
                    parse: (json) => {
                        if (!json) return null;
                        const year = Number(json.year);
                        const month = Number(json.month);
                        const day = Number(json.day);
                        const hour = Number(json.hour);
                        const minute = Number(json.minute);
                        const second = Number(json.seconds);
                        const milli = Number(json.milliSeconds || 0);
                        if (![year, month, day, hour, minute, second, milli].every(Number.isFinite)) return null;
                        return Date.UTC(year, month - 1, day, hour, minute, second, milli);
                    }
                },
                {
                    name: 'worldtimeapi/america-new_york',
                    url: 'https://worldtimeapi.org/api/timezone/America/New_York',
                    parse: (json) => {
                        if (!json) return null;
                        if (Number.isFinite(Number(json.unixtime))) return Number(json.unixtime) * 1000;
                        if (json.datetime) {
                            const parsed = Date.parse(json.datetime);
                            return Number.isFinite(parsed) ? parsed : null;
                        }
                        if (json.utc_datetime) {
                            const parsed = Date.parse(json.utc_datetime);
                            return Number.isFinite(parsed) ? parsed : null;
                        }
                        return null;
                    }
                },
                {
                    name: 'timeapi.io/utc',
                    url: 'https://timeapi.io/api/Time/current/zone?timeZone=UTC',
                    parse: (json) => {
                        if (!json) return null;
                        const year = Number(json.year);
                        const month = Number(json.month);
                        const day = Number(json.day);
                        const hour = Number(json.hour);
                        const minute = Number(json.minute);
                        const second = Number(json.seconds);
                        const milli = Number(json.milliSeconds || 0);
                        if (![year, month, day, hour, minute, second, milli].every(Number.isFinite)) return null;
                        return Date.UTC(year, month - 1, day, hour, minute, second, milli);
                    }
                },
                {
                    name: 'worldtimeapi/utc',
                    url: 'https://worldtimeapi.org/api/timezone/Etc/UTC',
                    parse: (json) => {
                        if (!json) return null;
                        if (Number.isFinite(Number(json.unixtime))) return Number(json.unixtime) * 1000;
                        if (json.datetime) {
                            const parsed = Date.parse(json.datetime);
                            return Number.isFinite(parsed) ? parsed : null;
                        }
                        if (json.utc_datetime) {
                            const parsed = Date.parse(json.utc_datetime);
                            return Number.isFinite(parsed) ? parsed : null;
                        }
                        return null;
                    }
                }
            ];
            this.metrics = {
                totalUpdates: 0,
                lastUpdateTs: 0,
                streamStates: {}
            };

            console.log('[AsyncRefreshEngine] Initialized (async, event-driven architecture)');
        }

        /**
         * Start all async streams
         */
        async start() {
            if (this.running) {
                console.warn('[AsyncRefreshEngine] Already running');
                return;
            }

            this.running = true;
            this.metrics.startMs = Date.now();
            console.log('[AsyncRefreshEngine] ⚡ Starting async streams...');

            await this.syncClock(true);

            // Fire all streams in parallel — they run independently and never block startup.
            void this.streamPredictions().catch(err => console.error('[AsyncRefreshEngine] predictions stream failed:', err));
            void this.streamKalshiBalance().catch(err => console.error('[AsyncRefreshEngine] balance stream failed:', err));
            void this.streamMarketData().catch(err => console.error('[AsyncRefreshEngine] market stream failed:', err));
            void this.streamSettlementPulse().catch(err => console.error('[AsyncRefreshEngine] settlement stream failed:', err));

            return this.getMetrics();
        }

        /**
         * Stop all streams
         */
        stop() {
            this.running = false;
            console.log('[AsyncRefreshEngine] ⏹ Stopping streams');
            this.streams.clear();
        }

        nowMs() {
            return Date.now() + this.clockOffsetMs;
        }

        async syncClock(force = false) {
            if (!force && this.clockSyncInFlight) return this.clockSyncInFlight;

            const ageMs = this.clockSyncedAt ? (this.nowMs() - this.clockSyncedAt) : Infinity;
            if (!force && ageMs < this.clockResyncIntervalMs) {
                return { source: this.clockSource, offsetMs: this.clockOffsetMs, ageMs };
            }

            const run = (async () => {
                const fetchSource = async (source) => {
                    const ctrl = new AbortController();
                    const timeoutId = setTimeout(() => ctrl.abort(), 2500);
                    try {
                        const res = await fetch(source.url, { signal: ctrl.signal });
                        if (!res.ok) throw new Error(`${source.name} HTTP ${res.status}`);
                        const json = await res.json();
                        const sourceMs = source.parse(json);
                        if (!Number.isFinite(sourceMs)) throw new Error(`${source.name} returned invalid timestamp`);
                        return { ...source, sourceMs };
                    } finally {
                        clearTimeout(timeoutId);
                    }
                };

                try {
                    const winner = await Promise.any(this.timeSyncSources.map(source => fetchSource(source)));
                    const localMs = Date.now();
                    const offsetMs = winner.sourceMs - localMs;
                    this.clockOffsetMs = offsetMs;
                    this.clockSource = winner.name;
                    this.clockSyncedAt = localMs;
                    console.log(
                        `[AsyncRefreshEngine] Clock synced via ${winner.name} ` +
                        `(offset ${offsetMs >= 0 ? '+' : ''}${offsetMs}ms, ` +
                        `ET ${this.formatEasternTime(winner.sourceMs)})`
                    );
                    return { source: winner.name, offsetMs, sourceMs: winner.sourceMs, syncedAt: localMs };
                } catch (err) {
                    console.warn('[AsyncRefreshEngine] Clock sync failed; keeping last known offset.', err.message);
                    if (!this.clockSyncedAt) {
                        this.clockOffsetMs = 0;
                        this.clockSource = 'system';
                    }
                    return { source: this.clockSource, offsetMs: this.clockOffsetMs, error: err.message };
                }
            })();

            this.clockSyncInFlight = run.finally(() => {
                if (this.clockSyncInFlight === run) this.clockSyncInFlight = null;
            });

            return this.clockSyncInFlight;
        }

        formatEasternTime(ts = this.nowMs()) {
            try {
                const parts = this.etFormatter.formatToParts(new Date(ts));
                const map = Object.fromEntries(parts.map(part => [part.type, part.value]));
                return `${map.month}/${map.day}/${map.year} ${map.hour}:${map.minute}:${map.second} ${map.timeZoneName || 'ET'}`;
            } catch (_) {
                return new Date(ts).toLocaleString('en-US', { timeZone: 'America/New_York' });
            }
        }

        /**
         * STREAM 1: Predictions (30s cycle)
         * Runs in background continuously. UI gets notified of new predictions via event.
         */
        async streamPredictions() {
            const streamId = 'predictions';
            let cycle = 0;
            let nextRunAt = this.nextAlignedAt(30_000);

            while (this.running) {
                try {
                    await this.sleepUntil(nextRunAt);
                    if (!this.running) break;

                    cycle++;
                    const cycleStart = this.nowMs();

                    // Trigger prediction run asynchronously
                    if (window.PredictionEngine?.runAll) {
                        const predictionPromise = Promise.resolve().then(() => window.PredictionEngine.runAll());

                        // Timeout guard: 25s
                        const predictions = await Promise.race([
                            predictionPromise,
                            new Promise((_, reject) =>
                                setTimeout(() => reject(new Error('Predictions timeout (25s)')), 25000)
                            )
                        ]);

                        const elapsedMs = Date.now() - cycleStart;

                        // Emit event so UI can update (non-blocking)
                        this.bus.emit('predictions:updated', {
                            predictions: window._predictions || {},
                            cycle,
                            elapsedMs,
                            timestamp: this.nowMs()
                        });

                        this.metrics.totalUpdates++;
                        this.metrics.lastUpdateTs = this.nowMs();
                        this.metrics.streamStates[streamId] = `✓ cycle ${cycle} (${elapsedMs}ms)`;

                        console.log(`[Stream:Predictions] Cycle ${cycle} complete (${elapsedMs}ms)`);
                    }

                    nextRunAt = this.nextAlignedAt(30_000, nextRunAt + 30_000);
                } catch (err) {
                    console.warn(`[Stream:Predictions] Error:`, err.message);
                    this.metrics.streamStates[streamId] = `⚠ ${err.message}`;
                    await this.sleepUntil(Date.now() + 5_000);
                    nextRunAt = this.nextAlignedAt(30_000);
                }
            }
        }

        /**
         * STREAM 2: Kalshi Balance (5s cycle)
         * Polls balance independently, emits updates for UI badge refresh.
         */
        async streamKalshiBalance() {
            const streamId = 'kalshi-balance';
            let cycle = 0;
            let nextRunAt = this.nextAlignedAt(5_000);

            while (this.running) {
                try {
                    await this.sleepUntil(nextRunAt);
                    if (!this.running) break;

                    cycle++;
                    const start = this.nowMs();

                    if (window.Kalshi?.getBalance) {
                        const res = await Promise.race([
                            window.Kalshi.getBalance(),
                            new Promise((_, reject) =>
                                setTimeout(() => reject(new Error('Balance fetch timeout')), 8000)
                            )
                        ]);

                        if (res.success && res.data) {
                            window._kalshiBalance = {
                                balance: res.data.balance,
                                portfolio_value: res.data.portfolio_value,
                                timestamp: this.nowMs(),
                            };

                            const elapsedMs = this.nowMs() - start;

                            this.bus.emit('kalshi:balance-updated', {
                                balance: res.data.balance,
                                portfolio_value: res.data.portfolio_value,
                                elapsedMs,
                                timestamp: this.nowMs()
                            });

                            this.metrics.streamStates[streamId] = `✓ $${(res.data.balance / 100).toFixed(2)}`;
                        }
                    }

                    nextRunAt = this.nextAlignedAt(5_000, nextRunAt + 5_000);
                } catch (err) {
                    console.warn(`[Stream:KalshiBalance] Error:`, err.message);
                    this.metrics.streamStates[streamId] = `⚠ ${err.message}`;
                    await this.sleepUntil(Date.now() + 5_000);
                    nextRunAt = this.nextAlignedAt(5_000);
                }
            }
        }

        /**
         * STREAM 3: Market Data (adaptive frequency)
         * Fetches market data on a dynamic schedule.
         * Fast during settlement windows, slower during quiet periods.
         */
        async streamMarketData() {
            const streamId = 'market-data';
            let cycle = 0;

            while (this.running) {
                try {
                    const msUntilSettlement = this.msUntilNextSettlementBoundary();
                    const nearBoundary = msUntilSettlement < 60000; // < 1 min before boundary
                    const desiredInterval = document.hidden ? 60000 : (nearBoundary ? 3000 : 15000);
                    const nextRunAt = this.nextAlignedAt(desiredInterval);

                    await this.sleepUntil(nextRunAt);
                    if (!this.running) break;

                    cycle++;
                    const start = this.nowMs();

                    // Fetch market data (non-blocking call)
                    if (window.fetchAll) {
                        await Promise.race([
                            Promise.resolve().then(() => window.fetchAll(false, false)),
                            new Promise((_, reject) =>
                                setTimeout(() => reject(new Error('Market data timeout')), 20000)
                            )
                        ]);

                        const elapsedMs = Date.now() - start;

                        this.bus.emit('market:data-updated', {
                            cycle,
                            elapsedMs,
                            nextIntervalMs: desiredInterval,
                            timestamp: this.nowMs()
                        });

                        this.metrics.streamStates[streamId] = `✓ cycle ${cycle} (${elapsedMs}ms, next ${desiredInterval}ms)`;
                    }
                } catch (err) {
                    console.warn(`[Stream:MarketData] Error:`, err.message);
                    this.metrics.streamStates[streamId] = `⚠ ${err.message}`;
                    await this.sleepUntil(this.nowMs() + 10000);
                }
            }
        }

        /**
         * STREAM 4: Settlement Pulses (quarterly)
         * Fires at every :00/:15/:30/:45 boundary.
         * Triggers high-priority data fetches and contract list updates.
         */
        async streamSettlementPulse() {
            const streamId = 'settlement-pulse';
            let pulseCount = 0;

            while (this.running) {
                try {
                    const nextBoundaryTs = this.nextSettlementBoundaryTs();

                    // Wait until next settlement boundary
                    await this.sleepUntil(nextBoundaryTs + 100); // +100ms buffer

                    if (!this.running) break;

                    pulseCount++;
                    const now = new Date();
                    const label = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

                    console.log(`[Stream:SettlementPulse] ⚡ ${label} — PULSE #${pulseCount}`);

                    // High-priority market data fetch (no cache)
                    if (window.fetchAll) {
                        await Promise.race([
                            Promise.resolve().then(() => window.fetchAll(true, true)),
                            new Promise((_, reject) =>
                                setTimeout(() => reject(new Error('Settlement fetch timeout')), 15000)
                            )
                        ]);
                    }

                    // Update Kalshi contracts
                    if (window.PredictionMarkets?.fetchAll) {
                        await window.PredictionMarkets.fetchAll();
                    }

                    this.bus.emit('settlement:pulse', {
                        pulseCount,
                        time: label,
                        timestamp: this.nowMs()
                    });

                    this.metrics.streamStates[streamId] = `✓ pulse ${pulseCount} @ ${label}`;
                } catch (err) {
                    console.warn(`[Stream:SettlementPulse] Error:`, err.message);
                    this.metrics.streamStates[streamId] = `⚠ ${err.message}`;
                }
            }
        }

        /**
         * Helper: Calculate ms until next settlement boundary (:00/:15/:30/:45)
         */
        msUntilNextSettlementBoundary() {
            return Math.max(1000, this.nextSettlementBoundaryTs() - this.nowMs());
        }

        /**
         * Helper: Return the next absolute quarter-hour boundary timestamp.
         */
        nextSettlementBoundaryTs() {
            const now = this.nowMs();
            const nextBoundary = Math.ceil(now / 900_000) * 900_000;
            return nextBoundary;
        }

        /**
         * Helper: Return the next absolute boundary for a cadence, optionally
         * anchored to an existing target to avoid cumulative jitter.
         */
        nextAlignedAt(periodMs, anchorTs = Date.now()) {
            const base = Math.floor(anchorTs / periodMs) * periodMs;
            const next = base + periodMs;
            return Math.max(this.nowMs(), next);
        }

        /**
         * Helper: Sleep until an absolute timestamp.
         */
        sleepUntil(targetTs) {
            return this.sleep(Math.max(0, targetTs - this.nowMs()));
        }

        /**
         * Helper: Non-blocking sleep
         */
        sleep(ms) {
            return new Promise(resolve => setTimeout(resolve, ms));
        }

        /**
         * Expose event subscriptions to UI
         */
        on(event, callback) {
            return this.bus.on(event, callback);
        }

        /**
         * Get current engine metrics
         */
        getMetrics() {
            return {
                ...this.metrics,
                running: this.running,
                uptime: this.nowMs() - (this.metrics.startMs || this.nowMs()),
                clockSource: this.clockSource,
                clockOffsetMs: this.clockOffsetMs,
                clockSyncedAt: this.clockSyncedAt,
                clockTimeET: this.formatEasternTime(this.nowMs())
            };
        }

        /**
         * Expose debug log
         */
        getStatus() {
            const status = [];
            status.push('═══════════════════════════════════════════');
            status.push('AsyncRefreshEngine Status');
            status.push('═══════════════════════════════════════════');
            status.push(`Running: ${this.running ? '✓ YES' : '✗ NO'}`);
            status.push(`Clock: ${this.clockSource} (offset ${this.clockOffsetMs >= 0 ? '+' : ''}${this.clockOffsetMs}ms)`);
            status.push(`Now ET: ${this.formatEasternTime(this.nowMs())}`);
            status.push(`Total Updates: ${this.metrics.totalUpdates}`);
            status.push(`Last Update: ${this.formatEasternTime(this.metrics.lastUpdateTs || this.nowMs())}`);
            status.push('Stream States:');
            for (const [stream, state] of Object.entries(this.metrics.streamStates)) {
                status.push(`  ${stream}: ${state}`);
            }
            status.push('═══════════════════════════════════════════');
            return status.join('\n');
        }
    }

    // ── Global Instance ────────────────────────────────────────────
    window.AsyncRefreshEngine = AsyncRefreshEngine;
    window._asyncRefreshEngine = new AsyncRefreshEngine();
    window.WeCryptoClock = {
        nowMs: () => window._asyncRefreshEngine?.nowMs?.() ?? Date.now(),
        formatEasternTime: (ts) => window._asyncRefreshEngine?.formatEasternTime?.(ts),
        syncClock: (force = false) => window._asyncRefreshEngine?.syncClock?.(force),
        getStatus: () => window._asyncRefreshEngine?.getMetrics?.()
    };

    console.log('[AsyncRefreshEngine] Ready — use window._asyncRefreshEngine.start() to begin');
})();
