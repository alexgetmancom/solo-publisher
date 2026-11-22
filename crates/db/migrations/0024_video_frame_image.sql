-- The frame itself, not only the arithmetic over it. Numbers can be recomputed
-- from the image at any time; the image cannot be recovered from the numbers,
-- and the video it came from is gone a week after publishing.
ALTER TABLE video_frame_features ADD COLUMN image_path text;
--> statement-breakpoint
-- The opening is now one moment, two seconds in: past any intro animation and
-- before the first cut. Readings taken at other moments described a different
-- moment under the same name, and an axis that mixes them means nothing.
DELETE FROM video_frame_features WHERE at_seconds <> 2;
