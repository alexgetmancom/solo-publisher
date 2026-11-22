# Delivery scenario media

The scenarios' media inputs, as committed bytes: ffmpeg's encoders follow its build and, for video, the machine's core
count (slice and frame threading), and the goldens hash what delivery derives from these files. They are the inputs the
goldens were recorded from — ffmpeg 6.1.1 on 8 cores, each `ffmpeg -loglevel error <args> <file>`:

| File | Arguments |
|---|---|
| `delivery-wide.jpg` | `-f lavfi -i testsrc=size=640x360:rate=1 -frames:v 1` |
| `delivery-clip.mp4` | `-f lavfi -i testsrc=size=320x180:rate=10 -f lavfi -i sine=frequency=440:sample_rate=48000 -t 1 -c:v libx264 -c:a aac -shortest` |
| `site-clip.mp4` | `-f lavfi -i testsrc=size=320x240:rate=10 -t 1 -pix_fmt yuv420p -c:v mpeg4` |
| `site-b.jpg` | `-f lavfi -i testsrc2=size=400x300:rate=1 -frames:v 1` |
