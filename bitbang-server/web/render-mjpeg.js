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
            return {
                frame(bytes) {
                    draw(bytes, b => {
                        /* Follow the sender: a resolution change arrives as a
                           differently sized frame and nothing else. Setting
                           width or height clears the canvas, so only on a
                           real change. */
                        if (el.width !== b.width || el.height !== b.height) {
                            el.width = b.width;
                            el.height = b.height;
                        }
                        ctx.drawImage(b, 0, 0);
                        b.close();
                    });
                },
                stop() {},
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
