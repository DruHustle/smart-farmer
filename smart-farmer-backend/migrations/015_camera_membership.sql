-- Camera grants and playback credentials belong to a particular farm membership.
ALTER TABLE camera_access ADD COLUMN farm_id uuid;
UPDATE camera_access g SET farm_id=a.farm_id FROM assets a WHERE a.id=g.asset_id;

DELETE FROM camera_access g WHERE NOT EXISTS (
  SELECT 1 FROM memberships m WHERE m.farm_id=g.farm_id AND m.user_id=g.user_id
) OR EXISTS (
  -- A member may have left and rejoined before the upgrade. Keep any new grant.
  SELECT 1 FROM audit_events revoked
  WHERE revoked.farm_id=g.farm_id AND revoked.entity_type='membership'
    AND revoked.entity_id=g.user_id AND revoked.action='access_revoked'
    AND NOT EXISTS (
      SELECT 1 FROM audit_events granted
      WHERE granted.farm_id=g.farm_id AND granted.entity_type='camera'
        AND granted.entity_id=g.asset_id AND granted.action='access_granted'
        AND granted.current->>'userId'=g.user_id::text AND granted.created_at>revoked.created_at
    )
);
ALTER TABLE camera_access ALTER COLUMN farm_id SET NOT NULL;
ALTER TABLE camera_access DROP CONSTRAINT camera_access_asset_id_fkey;
ALTER TABLE camera_access ADD FOREIGN KEY(farm_id,asset_id) REFERENCES assets(farm_id,id) ON DELETE CASCADE;
ALTER TABLE camera_access ADD FOREIGN KEY(user_id,farm_id) REFERENCES memberships(user_id,farm_id) ON DELETE CASCADE;
CREATE INDEX camera_access_membership ON camera_access(user_id,farm_id);

DELETE FROM camera_sessions s WHERE NOT EXISTS (
  SELECT 1 FROM memberships m WHERE m.farm_id=s.farm_id AND m.user_id=s.user_id
) OR EXISTS (
  SELECT 1 FROM audit_events revoked
  WHERE revoked.farm_id=s.farm_id AND revoked.entity_type='membership'
    AND revoked.entity_id=s.user_id AND revoked.action='access_revoked' AND revoked.created_at>=s.created_at
);
ALTER TABLE camera_sessions ADD FOREIGN KEY(user_id,farm_id) REFERENCES memberships(user_id,farm_id) ON DELETE CASCADE;
CREATE INDEX camera_sessions_membership ON camera_sessions(user_id,farm_id);
