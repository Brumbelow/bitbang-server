/*
 * An AudioWorklet that plays a stream of PCM frames arriving from somewhere
 * else, and absorbs the fact that the two clocks do not agree.
 *
 * The device samples at its own 16 kHz and the audio hardware plays at its
 * own, and neither is exactly right. Left alone the difference accumulates in
 * one direction forever: a few hundred parts per million is tens of
 * milliseconds over ten minutes, which ends as either a growing delay or a
 * stream of underruns, depending on which clock is faster.
 *
 * So the read position advances by a fractional step, and the step is nudged
 * by how far the ring sits from where it should. A rate change of a tenth of
 * a percent is about two cents of pitch, inaudible, and absorbs drift
 * indefinitely. See av-streaming-api.md.
 *
 * Nothing in process() allocates. The ring is fixed at construction, the
 * resampler works in place, and the stats go out on a timer rather than per
 * quantum, because a collection on the audio thread is a click.
 */

class PcmRing extends AudioWorkletProcessor {
    constructor(options) {
        super();
        const o = (options && options.processorOptions) || {};

        /* Two seconds, which is only how much can be held at once. What may
           be held is maxLatency, below, and it is much smaller. The two were
           the same thing once and that was the bug. */
        this.cap = o.capacity || 32000;
        this.buf = new Float32Array(this.cap);
        this.w = 0;             // write index
        this.r = 0;             // read index, integer part
        this.pos = 0;           // read position within the ring, fractional
        this.level = 0;         // samples held

        /* Where the ring should sit: enough to cover how late a frame can
           actually be.
         *
         * Measured against the device over a data channel, with audio the
         * only stream running: arrivals are p50 61 ms, p95 117, p99 160,
         * max 351. A frame can therefore be nearly 300 ms later than
         * nominal, and the buffer has to cover that or fall silent.
         *
         * 120 ms underran constantly. 200 ms left two or three underruns a
         * minute, all of them during the worst arrivals. 300 covers the
         * observed maximum.
         *
         * It is latency, and it is the price of a bursty transport. For
         * one-way listening 300 ms is imperceptible, and it is cheaper than
         * dropouts that are not. Two-way audio would have to revisit it,
         * since there the delay is the product.
         *
         * Video streaming at the same time is a different problem and no
         * target solves it: contention for the SCTP association lock
         * produced stalls over a second long. See esp32-video-transport.md. */
        this.target = o.targetSamples || 4800;   // 300 ms at 16 kHz

        /* DEVICE_RATE / ctx.sampleRate. 1.0 when the browser honors the
           request, 0.333 at 48 kHz, 0.363 at 44.1 -- one loop either way,
           because the branch would only ever run on hardware we do not
           own. */
        this.step = o.step || 1;

        /* The correction is proportional and capped. Capped because the cap
           is what keeps it inaudible; proportional because drift is a rate
           and wants a rate correction, not a splice.

           Symmetric, after an asymmetric version had the reasoning backwards.

           That version held the refill direction at 0.5%, arguing that
           slowing down barely helps because what refills a ring is the far
           side sending rather than this side reading gently. Measured, that
           is false exactly when the far side is sending slightly *less* than
           nominal. The buffer was watched walking from 1050 ms down to zero
           at 24 ms/s: 15 of that is this correction draining an overshoot,
           and the remaining 9 is arrivals running about 0.9% under rate --
           four or five lost frames a minute. Slowing playback 1.5% holds back
           240 samples a second, comfortably more than that shortfall, so the
           ring rides it out rather than reaching zero. Capped at 0.5% it
           could not, and underran.

           Consumption is the only half of the rate this side governs, and it
           is worth using in both directions.

           Running *above* target costs only latency, and there is no reason
           to be gentle about giving that back. Measured against the device:
           after two underruns the ring refilled to 480 ms against a 300 ms
           target and stayed there, because at 60% over target the
           proportional term still only computed 0.3% -- 48 samples a second,
           a full minute to drain 180 ms. The buffer was far more willing to
           take latency than to return it, and the excess is what you hear.

           1.5% is about 26 cents of pitch. On speech, sustained, that is not
           something anyone picks up without a reference to compare against,
           and it only runs while there is an overshoot to remove. It drains
           240 samples a second: the same 180 ms comes back in 12 s. */
        this.maxCorrection = o.maxCorrection || 0.015;
        this.maxDrain = o.maxDrain || 0.015;

        /* How hard the loop pulls per unit of relative error, which used to
           be maxCorrection itself. See the correction in process(). */
        this.gain = o.gain || 0.03;

        /* How far behind live the stream may fall before samples are thrown
           away rather than played out.
         *
         * This is a different question from how big the ring is, and
         * conflating them was a bug: a one second burst after a stall fit
         * inside a two second ring, so nothing discarded it, and the 0.5%
         * correction drained the excess at 80 samples a second -- 200
         * seconds to recover a second of latency. For a live stream that is
         * indistinguishable from never.
         *
         * The correction is for drift, which is parts per million. An
         * excursion this size is not drift, it is a burst arriving after the
         * network stopped, and the right answer is to drop it: one
         * discontinuity now beats staying a second late forever. */
        this.maxLatency = o.maxLatencySamples || this.target * 3;
        this.resyncs = 0;

        /* Smoothing for the level the correction sees. One pole; a quantum
           is 128 samples, so at 16 kHz 0.002 puts the time constant near 4 s.
         *
         * A second was not enough. Real arrivals burst by up to 200 ms, which
         * passes straight through a one second filter, and the correction
         * spent its time leaning against jitter with the buffer sitting 60 ms
         * above target and the output pinned at 0.3%. Drift is a
         * minutes-long phenomenon and jitter is a sub-second one; four
         * seconds separates them, where one second sat between them.
         *
         * Started at the target so the loop does not spend its first seconds
         * unwinding a value it was never given. */
        this.smooth = o.smooth || 0.002;
        this.avg = this.target;

        this.underruns = 0;
        this.overruns = 0;
        this.correction = 0;
        this.sinceReport = 0;

        /* The low-water mark since the last report, which is the only number
           that says whether the target is the right size.
         *
         * `level` sawtooths by a whole frame and `avg` deliberately smooths
         * that away, so neither answers "how close did we come to running
         * out". This does: the headroom between it and zero is target that
         * could be given back as latency, and the headroom being consistently
         * large is the evidence for lowering the target rather than a guess
         * that it is safe to. Reset per window, so a single bad moment shows
         * in the window it happened in rather than pinning the figure for the
         * rest of the session. */
        this.minLevel = Infinity;

        /* Silent until the ring first reaches its target.
         *
         * Without this the first 60 ms are a burst of underruns -- the ring
         * is empty and process() runs before any frame has arrived, so it
         * fills the output with zeros a dozen times before the first frame
         * lands. Measured at 7 at 16 kHz and 23 at 48, all inside the first
         * frame interval, and audible as a click at the start of every
         * stream. Starting quiet costs one buffer of latency, once. */
        this.priming = true;

        /* The device time of the sample currently being played.
         *
         * Audio plays continuously, so its playback position is a clock, and
         * that is what video frames get selected against: draw the frame
         * whose pts is nearest this, drop the ones that miss. Every media
         * player is built this way round, because a dropped video frame at
         * 15-20 fps is close to invisible and 20 ms of missing audio is an
         * audible click. See av-streaming-api.md.
         *
         * Maintained by advancing it as samples are consumed and reanchoring
         * whenever the read position moves for any other reason -- a resync,
         * a re-prime -- because those are exactly the moments when counting
         * samples stops being the same thing as counting time. NaN until the
         * first frame arrives, so a consumer can tell "not yet" from zero. */
        this.playPts = NaN;
        this.rate = o.deviceRate || 16000;

        this.port.onmessage = (e) => this.onFrame(e.data);
    }

    /* Runs on the audio thread but outside process(), so a copy here is
       acceptable where an allocation inside process() would not be. */
    onFrame(msg) {
        /* Either a bare Float32Array or { pcm, ptsMs }. The timestamp is what
           makes this a clock rather than a buffer; without it the ring still
           plays, it just cannot say when. */
        const samples = (msg instanceof Float32Array) ? msg : (msg && msg.pcm);
        const ptsMs = (msg && msg.ptsMs !== undefined) ? msg.ptsMs : NaN;
        if (!(samples instanceof Float32Array)) return;
        const n = samples.length;

        /* Anchor on the first frame after silence: nothing is being played,
           so whatever arrives next is what plays next. */
        if (this.level === 0 && !Number.isNaN(ptsMs)) {
            this.playPts = ptsMs;
        }

        /* A ring that is already full means the far side is ahead of us by
           more than the buffer holds -- almost always the aftermath of a
           stall. Drop the oldest, because what is stale is worth less than
           what just arrived, and keeping it would only add delay. */
        if (this.level + n > this.cap) {
            const drop = this.level + n - this.cap;
            this.r = (this.r + drop) % this.cap;
            this.level -= drop;
            this.playPts += drop * 1000 / this.rate;
            this.overruns++;
        }

        for (let i = 0; i < n; i++) {
            this.buf[this.w] = samples[i];
            this.w = this.w + 1 === this.cap ? 0 : this.w + 1;
        }
        this.level += n;

        /* Too far behind live: skip forward to the target rather than play
           it out. Costs one discontinuity; the alternative is minutes of
           added delay that the drift correction is far too gentle to
           remove. */
        if (this.level > this.maxLatency) {
            const skip = this.level - this.target;
            this.r = (this.r + skip) % this.cap;
            this.level -= skip;
            this.playPts += skip * 1000 / this.rate;
            this.pos = 0;
            this.resyncs++;
        }
    }

    process(inputs, outputs) {
        const out = outputs[0][0];
        if (!out) return true;
        const n = out.length;

        /* Primes to the full target, not to some fraction of it.
         *
         * Priming shallower looks like it would shorten each underrun, and it
         * does not: a gap ends with a burst rather than a trickle, so the ring
         * reaches either threshold within about 50 ms of the data resuming.
         * Tried at 40% and the measured silence was the same, while the cost
         * was real -- playback resumed holding 200 ms of cushion right after
         * the event that had just shown the link was unstable. */
        if (this.priming) {
            if (this.level < this.target) {
                out.fill(0);
                this.report(n);
                return true;
            }
            this.priming = false;
            this.avg = this.level;
        }

        /* One extra sample because the interpolation reads the next one. */
        const needed = Math.ceil(n * this.step * (1 + this.maxCorrection)) + 2;
        if (this.level < needed) {
            out.fill(0);
            this.underruns++;
            /* Refill before speaking again, rather than restarting one
               quantum later and underrunning repeatedly the whole way
               through a gap. One silence per gap instead of dozens. */
            this.priming = true;
            /* The read position is meaningless once the data under it is
               gone; starting clean avoids interpolating across the gap. */
            this.pos = 0;
            /* Drop the remainder too, which is what makes the anchor in
               onFrame work.
             *
             * This branch does not consume, so level stops at whatever was
             * left -- under one quantum, but not zero. onFrame re-anchors
             * playPts only when level is exactly zero, so a fragment left
             * here means the next frame after a gap does not re-anchor, and
             * the clock resumes from where it stopped instead of from live.
             *
             * That is invisible while nothing reads the clock, and fatal once
             * video does: pause, wait, play, and the clock returns far behind
             * every frame in hand, so none is ever due and the picture
             * freezes. Found exactly that way -- on, off, on.
             *
             * What is discarded is a sub-quantum fragment stranded behind a
             * gap, with nothing to be contiguous with. */
            this.level = 0;
            /* And stop claiming a position, because there no longer is one.
             *
             * Nothing is audible during a gap, so the last value is not where
             * playback has reached -- it is where playback stopped. Keeping
             * it means reporting a stale clock for as long as the gap lasts,
             * and the far side cannot tell that from a live one.
             *
             * Resuming audio is the case that showed it. The element is
             * unpaused the moment play is pressed, but the first frame is a
             * subscribe message and a round trip away -- a few hundred
             * milliseconds during which this reported the position from
             * before the pause. Video read that, held every live frame as not
             * yet due, and drew whatever stale frame it still had that was
             * older than the resurrected clock.
             *
             * NaN until onFrame anchors again, which it does on the next
             * frame to arrive, since level is now zero. */
            this.playPts = NaN;
            this.report(n);
            return true;
        }

        /* Against the smoothed level, not the instantaneous one.
         *
         * The raw level sawtooths by a whole frame, because a frame arrives
         * at once and drains a quantum at a time. Feeding that straight into
         * the correction made it swing plus and minus 0.125% at the frame
         * rate -- twenty five times the 0.005% it exists to produce, and a
         * playback rate modulated at 16 Hz rather than held steady. The loop
         * was tracking the teeth instead of the trend.
         *
         * A second of smoothing is far longer than the sawtooth and far
         * shorter than any drift worth correcting, so the two separate
         * cleanly. */
        this.avg += (this.level - this.avg) * this.smooth;

        /* Proportional, with the gain separate from the caps.
         *
         * These were the same number, and that was the defect: with the gain
         * equal to the cap, the correction could only reach the cap at 100%
         * error. A ring sitting 60% over target -- 480 ms against 300, which
         * is what the device actually produced -- computed 0.3% and took a
         * minute to drain. The cap it was nominally limited by was never
         * once reachable, so the limit doing the work was the gain, silently,
         * and every argument about the cap being inaudible was beside the
         * point.
         *
         * 0.03 saturates the drain at 50% over target, which puts the loop's
         * time constant near 10 s against the 4 s smoothing above -- fast
         * enough to matter, slow enough that the two still separate and the
         * correction does not start chasing jitter again. */
        const err = (this.avg - this.target) / this.target;
        let c = err * this.gain;
        if (c > this.maxDrain) c = this.maxDrain;
        else if (c < -this.maxCorrection) c = -this.maxCorrection;
        this.correction = c;

        const stride = this.step * (1 + c);
        let pos = this.pos;

        for (let i = 0; i < n; i++) {
            const idx = pos | 0;
            const frac = pos - idx;
            let a = this.r + idx;
            if (a >= this.cap) a -= this.cap;
            let b = a + 1;
            if (b >= this.cap) b -= this.cap;
            out[i] = this.buf[a] + (this.buf[b] - this.buf[a]) * frac;
            pos += stride;
        }

        /* Consume only whole samples; the fraction carries to the next
           quantum, which is what makes a non-integer step exact over time
           rather than accumulating a rounding error per block. */
        const used = pos | 0;
        this.r = (this.r + used) % this.cap;
        this.level -= used;
        this.pos = pos - used;
        /* In device time, because the ring holds device samples -- the
           correction changes how fast we read them, not what they mean. */
        this.playPts += used * 1000 / this.rate;

        this.report(n);
        return true;
    }

    report(n) {
        /* Sampled here rather than at the point of consumption because every
           path through process() ends in a report -- including the underrun
           and priming returns, which are exactly the moments worth catching. */
        if (this.level < this.minLevel) this.minLevel = this.level;

        this.sinceReport += n;
        if (this.sinceReport < 2048) return;
        this.sinceReport = 0;
        this.port.postMessage({
            level: this.level,
            avg: this.avg,
            minLevel: this.minLevel,
            playPts: this.playPts,
            target: this.target,
            correction: this.correction,
            underruns: this.underruns,
            overruns: this.overruns,
            resyncs: this.resyncs,
        });
        this.minLevel = Infinity;
    }
}

registerProcessor('pcm-ring', PcmRing);
