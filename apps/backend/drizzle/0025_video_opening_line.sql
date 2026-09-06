-- The words a video opens with, kept apart from the whole text.
--
-- The opening is the one thing that decides a Short, and finding it inside a
-- script means knowing where it ends: in a written script it is the first
-- paragraph, in a transcript it is the first sentence, and neither is
-- recoverable once the text has been flattened into one column.
ALTER TABLE video_drafts ADD COLUMN opening_line text;
