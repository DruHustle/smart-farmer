-- Private asset evidence does not require an invented project activity.
ALTER TABLE private_media ALTER COLUMN activity_id DROP NOT NULL;
ALTER TABLE private_media ADD COLUMN asset_id uuid;
ALTER TABLE private_media ADD COLUMN financial boolean NOT NULL DEFAULT false;
ALTER TABLE private_media ADD CONSTRAINT private_media_asset_fk FOREIGN KEY(farm_id,asset_id) REFERENCES assets(farm_id,id);
ALTER TABLE private_media ADD CONSTRAINT private_media_one_parent CHECK(num_nonnulls(activity_id,asset_id)=1);
CREATE INDEX private_media_asset ON private_media(farm_id,asset_id,id);
-- Grant private camera-asset documents before a live provider is commissioned.
ALTER TABLE camera_access DROP CONSTRAINT camera_access_asset_id_fkey;
ALTER TABLE camera_access ADD CONSTRAINT camera_access_asset_id_fkey FOREIGN KEY(asset_id) REFERENCES assets(id) ON DELETE CASCADE;
