/*
 * Motion JPEG: one complete JPEG per frame, drawn as it arrives.
 *
 * There is no decoder here because the browser has one. createImageBitmap
 * decodes off the main thread and hands back something drawImage takes
 * directly, which is the whole renderer.
 *
 * A canvas rather than an <img> on a multipart stream, because
 * multipart/x-mixed-replace does not render in WebKit -- every browser on iOS
 * would show the page and no video. An <img> is still supported for a page
 * that wants one, fed from the same frames.
 *
 * Registered for both tags, and bound by the shim to whichever the page
 * actually contains. See av-streaming-api.md.
 */

/* Decoding is asynchronous and concurrent, so two frames can be in
   createImageBitmap at once and finish in the other order. Drawing the older
   one second would show a backwards step. The frames arrive in order --
   bootstrap guarantees that much -- so a counter is enough: decode everything,
   draw only what is still the newest.

   Worth being explicit that this is a decode-order problem, not a transport
   one. The channel is unordered, and the reassembly above this already turns
   that back into an ordered sequence. */
function drawer(el) {
    let issued = 0;
    let drawn = 0;
    let started = false;
    return (bytes, apply) => {
        const seq = ++issued;
        createImageBitmap(new Blob([bytes], { type: 'image/jpeg' })).then(b => {
            if (seq < drawn) { b.close(); return; }
            drawn = seq;
            apply(b);
            if (!started) {
                started = true;
                /* The page put up a placeholder, and only the page knows what
                   to do with it. Saying "a frame arrived" is the renderer's
                   whole business here. */
                el.dispatchEvent(new CustomEvent('bitbang-stream-start',
                                                 { bubbles: true }));
            }
        }).catch(() => {
            /* A truncated frame is a dropped frame. The transport already
               dropped it; this is just where that becomes visible. */
        });
    };
}

window.BitBang.streams.register({
    codec: 'mjpeg',
    tags: ['canvas', 'img'],

    create(el, info) {
        const tag = el.tagName.toLowerCase();
        const draw = drawer(el);

        if (tag === 'canvas') {
            const ctx = el.getContext('2d');

            const paint = (b) => {
                /* Follow the sender: a resolution change arrives as a
                   differently sized frame and nothing else. Setting width or
                   height clears the canvas, so only on a real change. */
                if (el.width !== b.width || el.height !== b.height) {
                    el.width = b.width;
                    el.height = b.height;
                }
                ctx.drawImage(b, 0, 0);
                b.close();
            };

            /* Frames waiting for their moment, oldest first.
             *
             * Only used while something is publishing a clock, which in
             * practice means while audio is playing. With no clock this stays
             * empty and frames are drawn the instant they arrive. */
            const pending = [];
            let decoding = false;
            let raf = 0;

            /* Enough for the deepest audio buffer with room over: at 20 fps
               and half a second of audio, about ten frames are in flight. The
               cap is a backstop against a clock that stops advancing, not a
               working limit -- the bytes are compressed, so thirty frames is
               a few hundred kilobytes rather than thirty decoded bitmaps. */
            const MAX_PENDING = 30;

            const tick = () => {
                raf = requestAnimationFrame(tick);

                const now = info.clock.get();
                if (Number.isNaN(now) || decoding || pending.length === 0) {
                    return;
                }

                /* The newest frame that is due. Anything older than it is
                   already past and drawing it would step backwards, so the
                   whole run goes at once. */
                let last = -1;
                for (let i = 0; i < pending.length; i++) {
                    if (pending[i].ptsMs <= now) last = i;
                    else break;
                }
                if (last < 0) {
                    return;     /* the clock has not reached the next frame */
                }

                const f = pending[last];
                pending.splice(0, last + 1);

                /* One decode at a time. The previous attempt at this ran
                   decodes concurrently and spliced the queue from each
                   completion, which reordered frames and read as jitter --
                   the bug that made synchronised video look worse than
                   unsynchronised. One consumer, one decode in flight. */
                decoding = true;
                createImageBitmap(new Blob([f.bytes], { type: 'image/jpeg' }))
                    .then(b => { paint(b); decoding = false; })
                    .catch(() => { decoding = false; });
            };

            return {
                frame(bytes, meta) {
                    /* No clock means nothing is playing audio, so there is
                       nothing to wait for: draw on arrival, which is both the
                       lowest latency and what this did before. */
                    if (Number.isNaN(info.clock.get())) {
                        draw(bytes, paint);
                        return;
                    }

                    if (raf === 0) {
                        raf = requestAnimationFrame(tick);
                    }
                    /* Copied because the buffer is the transferred frame and
                       the caller is free to reuse it once this returns. */
                    pending.push({ bytes: bytes.slice(), ptsMs: meta.ptsMs });
                    if (pending.length > MAX_PENDING) {
                        pending.splice(0, pending.length - MAX_PENDING);
                    }
                },
                stop() {
                    if (raf !== 0) {
                        cancelAnimationFrame(raf);
                        raf = 0;
                    }
                    pending.length = 0;
                },
            };
        }

        /* An <img> takes a URL, so each frame needs an object URL and each
           object URL needs revoking -- otherwise the page leaks a blob per
           frame, which at 20 fps is a megabyte a second held forever. Revoked
           on load rather than immediately: the decode is asynchronous and
           revoking first can race it. */
        let prev = null;
        let started = false;
        return {
            frame(bytes) {
                const url = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
                el.onload = () => {
                    if (prev) URL.revokeObjectURL(prev);
                    prev = url;
                    if (!started) {
                        started = true;
                        el.dispatchEvent(new CustomEvent('bitbang-stream-start',
                                                         { bubbles: true }));
                    }
                };
                el.src = url;
            },
            stop() {
                if (prev) URL.revokeObjectURL(prev);
                prev = null;
            },
        };
    },
});
