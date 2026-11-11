CREATE TABLE forum_author_blocks (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 viewer_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 author_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 display_name text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(viewer_id,author_id),
 CHECK(viewer_id<>author_id)
);
CREATE INDEX forum_author_blocks_viewer_page ON forum_author_blocks(viewer_id,created_at,id);

ALTER TABLE forum_reports ADD COLUMN target text NOT NULL DEFAULT 'content' CHECK (target IN ('content','author'));
ALTER TABLE forum_reports DROP CONSTRAINT forum_reports_entry_id_reporter_id_reported_version_key;
ALTER TABLE forum_reports ADD UNIQUE(entry_id,reporter_id,reported_version,target);
