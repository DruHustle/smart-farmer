-- Community content is deliberately separate from private farm records and media.
CREATE TABLE forum_entries (
 id uuid PRIMARY KEY,
 farm_id uuid NOT NULL REFERENCES farms(id),
 author_id uuid NOT NULL REFERENCES users(id),
 parent_id uuid REFERENCES forum_entries(id),
 display_name text NOT NULL CHECK (char_length(display_name) <= 50),
 title text,
 topic text CHECK (topic IN ('crops','livestock','soil','irrigation','equipment','markets','general')),
 body text NOT NULL CHECK (char_length(body) <= 8000),
 status text NOT NULL DEFAULT 'visible' CHECK (status IN ('visible','hidden','deleted')),
 version integer NOT NULL DEFAULT 1 CHECK (version > 0),
 moderation_reason text,
 payload_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK (parent_id IS NULL OR parent_id <> id),
 CHECK ((parent_id IS NULL AND topic IS NOT NULL AND title IS NOT NULL AND char_length(title) <= 160)
     OR (parent_id IS NOT NULL AND topic IS NULL AND title IS NULL)),
 CHECK (status = 'deleted' OR (char_length(btrim(body)) > 0 AND char_length(btrim(display_name)) >= 2)),
 CHECK (status = 'deleted' OR parent_id IS NOT NULL OR char_length(btrim(title)) >= 3)
);
CREATE INDEX forum_discussions_recent ON forum_entries(created_at DESC,id DESC) WHERE parent_id IS NULL AND status = 'visible';
CREATE INDEX forum_replies_order ON forum_entries(parent_id,created_at,id) WHERE parent_id IS NOT NULL;
CREATE INDEX forum_author_entries ON forum_entries(author_id,created_at DESC,id DESC);

CREATE TABLE forum_reports (
 id uuid PRIMARY KEY,
 entry_id uuid NOT NULL REFERENCES forum_entries(id),
 reporter_id uuid NOT NULL REFERENCES users(id),
 reported_version integer NOT NULL CHECK (reported_version > 0),
 reason text NOT NULL CHECK (reason IN ('spam','abuse','unsafe_advice','privacy','other')),
 details text NOT NULL DEFAULT '' CHECK (char_length(details) <= 1000),
 status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','dismissed','actioned')),
 payload_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 resolved_at timestamptz,
 resolved_by uuid REFERENCES users(id),
 resolution_note text,
 UNIQUE(entry_id,reporter_id,reported_version)
);
CREATE INDEX forum_open_reports ON forum_reports(created_at,id) WHERE status = 'open';
