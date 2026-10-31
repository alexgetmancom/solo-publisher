ALTER TABLE post_locales ADD COLUMN site_updated_at TEXT;
--> statement-breakpoint
-- Existing reviewed SEO titles and descriptions were real public edits. The
-- locale timestamp records that edit; other historical edits have no reliable date.
UPDATE post_locales SET site_updated_at = updated_at
WHERE site_enabled = 1 AND published_at IS NOT NULL AND seo_title IS NOT NULL
  AND julianday(updated_at) >= julianday(published_at)
  AND julianday(updated_at) <= julianday('now');
--> statement-breakpoint
CREATE TRIGGER post_locales_site_content_updated
AFTER UPDATE OF source_text, approved_text, html, site_media_json, slug, seo_title ON post_locales
WHEN OLD.site_enabled = 1 AND NEW.site_enabled = 1
  AND julianday(NEW.published_at) <= julianday('now')
  AND (coalesce(OLD.approved_text, OLD.source_text) IS NOT coalesce(NEW.approved_text, NEW.source_text)
    OR OLD.html IS NOT NEW.html OR OLD.site_media_json IS NOT NEW.site_media_json
    OR OLD.slug IS NOT NEW.slug OR OLD.seo_title IS NOT NEW.seo_title)
BEGIN
  UPDATE post_locales SET site_updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE draft_id = NEW.draft_id AND locale = NEW.locale;
END;
