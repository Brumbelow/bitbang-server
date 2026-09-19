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

        /* Where the ring should sit. Enough to cover one frame plus the
           jitter of its arrival; below this the first late frame is a gap. */
        this.target = o.targetSamples || 1920;   // 120 ms at 16 kHz

        /* DEVICE_RATE / ctx.sampleRate. 1.0 when the browser honors the
           request, 0.333 at 48 kHz, 0.363 at 44.1 -- one loop either way,
           because the branch would only ever run on hardware we do not
           own. */
        this.step = o.step || 1;

        /* The correction is proportional and capped. Capped because the cap
           is what keeps it inaudible; proportional because drift is a rate
           and wants a rate correction, not a splice. */
        this.maxCorrection = o.maxCorrection || 0.005;

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

        this.underruns = 0;
        this.overruns = 0;
        this.correction = 0;
        this.sinceReport = 0;

        /* Silent until the ring first reaches its target.
         *
         * Without this the first 60 ms are a burst of underruns -- the ring
         * is empty and process() runs before any frame has arrived, so it
         * fills the output with zeros a dozen times before the first frame
         * lands. Measured at 7 at 16 kHz and 23 at 48, all inside the first
         * frame interval, and audible as a click at the start of every
         * stream. Starting quiet costs one buffer of latency, once. */
        this.priming = true;

        this.port.onmessage = (e) => this.onFrame(e.data);
    }

    /* Runs on the audio thread but outside process(), so a copy here is
       acceptable where an allocation inside process() would not be. */
    onFrame(samples) {
        if (!(samples instanceof Float32Array)) return;
        const n = samples.length;

        /* A ring that is already full means the far side is ahead of us by
           more than the buffer holds -- almost always the aftermath of a
           stall. Drop the oldest, because what is stale is worth less than
           what just arrived, and keeping it would only add delay. */
        if (this.level + n > this.cap) {
            const drop = this.level + n - this.cap;
            this.r = (this.r + drop) % this.cap;
            this.level -= drop;
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
            this.pos = 0;
            this.resyncs++;
        }
    }

    process(inputs, outputs) {
        const out = outputs[0][0];
        if (!out) return true;
        const n = out.length;

        if (this.priming) {
            if (this.level < this.target) {
                out.fill(0);
                this.report(n);
                return true;
            }
            this.priming = false;
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
            this.report(n);
            return true;
        }

        /* Proportional, and saturating well before it is audible. Which
           makes it useless for large excursions -- at 0.5% it sheds 80
           samples a second -- and that is fine, because those are handled by
           maxLatency rather than here. This only has to cancel drift, which
           is parts per million. */
        const err = (this.level - this.target) / this.target;
        let c = err * this.maxCorrection;
        if (c > this.maxCorrection) c = this.maxCorrection;
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

        this.report(n);
        return true;
    }

    report(n) {
        this.sinceReport += n;
        if (this.sinceReport < 2048) return;
        this.sinceReport = 0;
        this.port.postMessage({
            level: this.level,
            target: this.target,
            correction: this.correction,
            underruns: this.underruns,
            overruns: this.overruns,
            resyncs: this.resyncs,
        });
    }
}

registerProcessor('pcm-ring', PcmRing);
