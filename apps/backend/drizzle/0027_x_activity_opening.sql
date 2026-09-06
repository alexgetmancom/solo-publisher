-- The line a post opens with, and what kind of line it is.
--
-- A reader decides on the first line the way a viewer decides on the first
-- seconds, and it is the one part of a post its author chooses twice. Kept
-- beside the post rather than derived on read: the kind is a judgement made
-- once, and it has to be reviewable against the words it was made from.
ALTER TABLE x_activity_items ADD COLUMN opening_line text;
--> statement-breakpoint
ALTER TABLE x_activity_items ADD COLUMN opening_kind text;
