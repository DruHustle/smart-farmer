ALTER TABLE memberships DROP CONSTRAINT memberships_role_check;
ALTER TABLE memberships ADD CONSTRAINT memberships_role_check
 CHECK (role IN ('owner','manager','worker','adviser','viewer'));

ALTER TABLE invitations DROP CONSTRAINT invitations_role_check;
ALTER TABLE invitations ADD CONSTRAINT invitations_role_check
 CHECK (role IN ('manager','worker','adviser','viewer'));
