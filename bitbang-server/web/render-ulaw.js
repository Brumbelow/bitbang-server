/*
 * G.711 u-law into an ordinary <audio> element.
 *
 * No element accepts a stream of PCM frames, which made audio look like it
 * needed an architecture of its own. It does not, as long as the renderer may
 * build a sink and hand it back: the worklet feeds a
 * MediaStreamAudioDestinationNode, the element plays that MediaStream, and
 * volume, mute and the browser's own controls work the way the page author
 * expects. A codec no browser has heard of ends up looking standard from the
 * page's side.
 *
 * The ring buffer and the drift correction live in pcm-ring.js, on the audio
 * thread, where they have to be. This file is the decode and the plumbing.
 *
 * See av-streaming-api.md.
 */

/* The inverse of what the device encodes, as a 256 entry table -- which is the
   entire decoder, on either side. Built once for the module rather than per
   instance. */
const ULAW = new Float32Array(256);
for (let u = 0; u < 256; u++) {
    const v = ~u & 255;
    let t = ((v & 15) << 3) + 132;
    t <<= (v & 112) >> 4;
    ULAW[u] = ((v & 128) ? (132 - t) : (t - 132)) / 32768;
}

/* The microphone sits about 45 dB below full scale, so unity is correct and
   inaudible. This is makeup gain for that, not a volume control: the element's
   own volume attenuates from here, which is what the page and the user
   actually reach for. */
const MAKEUP = 40;

window.BitBang.streams.register({
    codec: 'ulaw',
    tags: ['audio'],

    async create(el, info) {
        const rate = info.rate || 16000;

        /* Ask for the device's rate so the worklet can read the ring one
           sample per output sample. A browser that refuses -- and several do,
           pinning the context to the output device -- is handled by `step`
           below rather than by resampling here. */
        const ctx = new AudioContext({ sampleRate: rate });
        await ctx.audioWorklet.addModule(window.BitBang.streams.asset('pcm-ring.js'));

        const node = new AudioWorkletNode(ctx, 'pcm-ring', {
            outputChannelCount: [1],
            processorOptions: {
                step: rate / ctx.sampleRate,
                deviceRate: rate,
                capacity: rate * 2,
            },
        });

        /* Drains the stats port as much as reads it.
         *
         * A MessagePort starts disabled and queues everything sent to it until
         * something calls start(), which assigning onmessage does. Leave it
         * unread and the ring's report -- about eight objects a second --
         * piles up for as long as anyone listens. The symptom is a page that
         * slowly bogs down: a slider that drags well at first and goes sticky
         * several seconds in, and comes right after a refresh. */
        let stats = null;
        /* The low-water mark over a window long enough to contain the worst
           arrival, rather than the one-eighth of a second each report covers.
           What it is for: the gap between this and zero is latency the target
           is holding and not using, and it is the evidence for changing the
           target rather than an argument that it would probably be fine. */
        let floor = Infinity, since = 0;
        node.port.onmessage = (e) => {
            stats = e.data;
            if (!Number.isNaN(stats.playPts)) {
                /* What moment is currently audible. Audio plays continuously,
                   so its position is the clock any other stream would be
                   selected against. Nothing consumes it yet. */
                el.__bbPlayPts = stats.playPts;
            }

            if (stats.minLevel < floor) floor = stats.minLevel;
            const now = performance.now();
            if (!since) since = now;
            if (now - since >= 5000) {
                const ms = (n) => Math.round(n / (rate / 1000));
                console.log(`[audio] buffer ${ms(stats.level)} ms, ` +
                            `low ${Number.isFinite(floor) ? ms(floor) : '?'} ms ` +
                            `of ${ms(stats.target)} target, ` +
                            `under ${stats.underruns}, resync ${stats.resyncs}`);
                floor = Infinity;
                since = now;
            }
        };

        const gain = ctx.createGain();
        gain.gain.value = MAKEUP;
        const dest = ctx.createMediaStreamDestination();
        node.connect(gain).connect(dest);
        el.srcObject = dest.stream;

        /* Play and pause are the whole control surface, and they mean what
           they say.
         *
         * An AudioContext will not start without a user gesture, and a
         * MediaStreamDestination fed by a suspended context produces nothing
         * -- the element would sit there playing silence. Pressing play is
         * that gesture. That is also why <audio> wants `controls`: without
         * them the page has to supply a button, and with them the browser
         * already did.
         *
         * Pause stops the device sending rather than merely muting what it
         * sent. A microphone nobody is listening to still costs a capture, a
         * u-law pass, 17 messages a second and a share of an SCTP association
         * that video is already contending for -- see esp32-video-transport.md
         * for what that contention costs. Stopping at the source is the only
         * place that gives any of it back.
         *
         * The context keeps running while paused, deliberately. Suspending it
         * would be the obvious saving and it is wrong: the ring freezes with
         * whatever it held, and resuming plays that 300 ms of stale audio from
         * the moment of the pause before any live sample arrives -- resuming
         * where you left off, which is the behavior we are trying not to have.
         * Left running, the ring drains to empty, the worklet primes, and play
         * starts from live. An idle audio thread is the cheaper mistake. */
        el.addEventListener('play', () => {
            if (ctx.state === 'suspended') ctx.resume();
            info.setActive(true);
        });
        el.addEventListener('pause', () => info.setActive(false));

        /* The element starts paused, so nothing is wanted yet. Said once here
           rather than assumed, because the shim's default is to subscribe and
           this is the renderer that does not want that. */
        info.setActive(!el.paused);

        /* Reused across frames. Frames are a constant 60 ms in practice, so
           this allocates once and then never. */
        let pcm = null;

        return {
            frame(bytes, meta) {
                if (!pcm || pcm.length !== bytes.length) {
                    pcm = new Float32Array(bytes.length);
                }
                for (let i = 0; i < bytes.length; i++) pcm[i] = ULAW[bytes[i]];
                node.port.postMessage({ pcm, ptsMs: meta.ptsMs });
            },
            stats() { return stats; },
            stop() {
                el.srcObject = null;
                ctx.close();
            },
        };
    },
});
