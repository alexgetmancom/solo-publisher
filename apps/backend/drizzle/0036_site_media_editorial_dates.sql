-- Rendering derivatives is bookkeeping; only editorial media changes re-date a post.
DROP TRIGGER post_locales_site_content_updated;
--> statement-breakpoint
CREATE TRIGGER post_locales_site_content_updated
AFTER UPDATE OF source_text, approved_text, html, site_media_json, slug, seo_title ON post_locales
WHEN OLD.site_enabled = 1 AND NEW.site_enabled = 1
  AND julianday(NEW.published_at) <= julianday('now')
  AND (coalesce(OLD.approved_text, OLD.source_text) IS NOT coalesce(NEW.approved_text, NEW.source_text)
    OR OLD.html IS NOT NEW.html OR OLD.slug IS NOT NEW.slug OR OLD.seo_title IS NOT NEW.seo_title
    OR (SELECT json_group_array(json_object(
      'id', coalesce(json_extract(value, '$.asset_id'), json_extract(value, '$.file_id'), json_extract(value, '$.fileId'),
        json_extract(value, '$.local_path'), json_extract(value, '$.localPath'),
        replace(replace(CASE WHEN instr(json_extract(value, '$.path'), '?') > 0
          THEN substr(json_extract(value, '$.path'), 1, instr(json_extract(value, '$.path'), '?') - 1)
          ELSE json_extract(value, '$.path') END, '-vertical.jpg', '.jpg'), '-vertical.mp4', '.mp4')),
      'type', CASE WHEN lower(json_extract(value, '$.type')) = 'video' THEN 'video' ELSE 'image' END,
      'alt', coalesce(json_extract(value, '$.alt'), '')))
    FROM json_each(coalesce(OLD.site_media_json, '[]'))
    WHERE coalesce(json_extract(value, '$.role'), '') <> 'text_story_card') IS NOT (SELECT json_group_array(json_object(
      'id', coalesce(json_extract(value, '$.asset_id'), json_extract(value, '$.file_id'), json_extract(value, '$.fileId'),
        json_extract(value, '$.local_path'), json_extract(value, '$.localPath'),
        replace(replace(CASE WHEN instr(json_extract(value, '$.path'), '?') > 0
          THEN substr(json_extract(value, '$.path'), 1, instr(json_extract(value, '$.path'), '?') - 1)
          ELSE json_extract(value, '$.path') END, '-vertical.jpg', '.jpg'), '-vertical.mp4', '.mp4')),
      'type', CASE WHEN lower(json_extract(value, '$.type')) = 'video' THEN 'video' ELSE 'image' END,
      'alt', coalesce(json_extract(value, '$.alt'), '')))
    FROM json_each(coalesce(NEW.site_media_json, '[]'))
    WHERE coalesce(json_extract(value, '$.role'), '') <> 'text_story_card'))
BEGIN
  UPDATE post_locales SET site_updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE draft_id = NEW.draft_id AND locale = NEW.locale;
END;
