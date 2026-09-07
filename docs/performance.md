# Reader loading

The UI, catalogue, volume metadata and manifests are static GitHub Pages files.
Images are requested directly from BBAW, not proxied through an application
server. Changes to this reader cannot eliminate upstream latency.

## Initial probe

One network probe from the development environment used Galen volume
`cmg_05_02_01`, physical scan 12. The volume JSON was 105,387 bytes, its existing
200-pixel thumbnail 16,561 bytes, and the 1600-pixel reading image 605,845 bytes.
The preview is about 37 times smaller than that reading image. This is a byte
comparison, not a measured improvement in page-display time.

Observed total request times were 10.643, 11.731 and 12.526 seconds respectively.
Most time elapsed before response headers, including for GitHub metadata. This
single development-network sample cannot distinguish BBAW latency from network
or environment overhead, or explain another user's experience.

## Changes and checks

- On an interior page jump, the explicit request order changes from
  `n-2, n-1, n, n+1, n+2` to `n, n+1, n-1`: three reading-image requests rather
  than five. The viewport observer can still load additional visible images.
- The selected image receives high fetch priority; neighbours and rail
  thumbnails receive low priority. These are browser hints, not bandwidth
  guarantees. The offscreen observer margin falls from 150% to 50%.
- The selected page alone gets an existing thumbnail preview when it has no
  usable reading image. It is labelled until the reading image has loaded and
  decoded. A late preview is invalidated after replacement or page release.
- Zoom still uses the previous resolution rules, including up to 3600 pixels.
  Existing images remain visible during higher-resolution loads.
- URLs and width buckets remain stable for normal HTTP-cache reuse. Existing
  loaded/pending-image guards prevent duplicate requests for sufficient
  resolution. Images within eight page positions remain available; more distant
  images and their previews are released. There is no new persistent image cache.
- A preconnect starts the connection to BBAW while metadata is loading.

Unit tests cover selected-page-first ordering, volume boundaries, preview
replacement, late events after cancellation and thumbnail failure. Existing
navigation and gesture regression tests must also pass.

Browser rendering, throttled desktop/mobile timings, peak decoded-image memory
and a physical-device comparison have not been measured in this environment.
The next user-side comparison should cover a fresh opening, refresh, adjacent
page turns, a distant jump, return navigation and zoom in the same volume and
connection. Record time to preview separately from time to a readable image;
an early thumbnail is not evidence that the final image downloaded faster.
