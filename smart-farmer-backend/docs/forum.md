# Farmer Forum

The Forum is a signed-in community for farming discussions and replies. It is
separate from the private farm workspace. The web navigation and native bottom
navigation both have a Forum tab, with Shona and Northern Ndebele copy following
the existing translation-review policy.

## Sharing and identity

Every request needs a valid opaque session and a current membership in the farm
selected in the workspace. Feed and discussion reads can include deliberately
shared content from other farms. Topic filters, text search and bounded cursor
pagination make those discussions discoverable; an empty community shows an
empty state, without manufactured posts or activity.

Publication requires a chosen public display name, text and an explicit
`shareWithCommunity: true` acknowledgement. The display name is supplied by the
author; it is not a verified identity. Account usernames, farm names, membership
lists, internal author/source-farm identifiers, private records, coordinates and
media are not included in community DTOs. The composer has no attachment or
private-record import. Authors should share only information they intend all
signed-in community members to see.

Web and native clients render text nodes. They do not render community HTML,
Markdown, scripts, embedded media or automatic links. The API rejects unknown
fields, unsupported control characters, empty text and oversized input. Limits
are 50 characters for display names, 160 for discussion titles, 8,000 for bodies,
and 1,000 for report details/moderation reasons. The API's existing body-size and
rate limits remain in force, with a lower per-route limit for Forum writes.

## Ownership, moderation and deletion

Authors with a current membership in the content's source farm may edit or
remove their own posts and replies. Updates and removals require the current
version. A hidden post stays hidden when its author edits it; editing never
restores publication automatically.

Any current community member may report another author's visible content.
Reports are private to the current owners of the source farm. The report DTO
does not identify the reporter. A duplicate report for the same content version
is refused; changed content can be reported again.

An owner can moderate only content shared through the currently selected farm.
Being an owner elsewhere does not grant authority over another farm's posts.
There is no new global moderator role. Owners have separate views for open
reports and hidden content, with explicit hide, restore and report-dismissal
actions. These actions require the latest content version and a recorded
reason. The UI highlights content changed since a report was filed.

Every write rechecks and locks the current session and membership inside its
transaction, including idempotent replays. Author writes also check the current
source-farm membership. Owner moderation checks the current database role and
exact source farm. This prevents an in-flight request from using a membership
or session already revoked before the write acquires its authorization locks.

Removal is a public tombstone: the stored public body and display name are
cleared. A removed discussion and its replies are no longer available as a
community thread; a removed reply is shown as a tombstone within its thread.
Owners cannot restore author-deleted content. Existing private audit records
retain action/status/version information, without copying post bodies; report
details remain private moderation evidence. This is not a claim of deletion
from backups or every historical operational record.

## Offline and concurrency behavior

Forum reads and publication require a current online session. Forum content is
not added to the encrypted private-record snapshot, native outbox or web vault.
An open composer holds its text in component memory only; leaving that form,
changing farms or locking/signing out discards that unsent text. Reconnection
does not publish it. A failed publication remains visible in the form for the
user to inspect; the clients do not automatically retry or enqueue it.

New discussions and replies use a client-generated UUID retained for that
composer. The server serializes that identifier and checks the actor and exact
validated payload hash. An identical retry returns the original result; the
same identifier with a different payload returns `idempotency_conflict`.
Removal does not free a publication identifier for reuse. Reports have the
same request-identity check. Version checks prevent silent overwrites for
edits, removals and moderation.

All feed, reply, report and hidden-content cursors retain PostgreSQL's full
microsecond timestamp plus the UUID. Display timestamps can use ordinary JSON
dates; pagination never derives its cursor from JavaScript's lower-precision
Date value.

## API

All paths below start with `/v1/farms/:farmId/forum`.

| Method and path | Behavior |
| --- | --- |
| `GET /discussions` | Visible community discussions; `topic`, `search`, `mine`, `limit`, `cursor`. The author-only `mine=true` view can include that author's hidden discussions. |
| `POST /discussions` | Explicitly share `{id, displayName, title, topic, body, shareWithCommunity:true}`. |
| `GET /discussions/:id` | One visible discussion and a paginated reply page; authors/source-farm owners may inspect hidden discussions. |
| `POST /discussions/:id/replies` | Explicitly share `{id, displayName, body, shareWithCommunity:true}` under a visible discussion. |
| `PATCH /entries/:id` | Author edit with `version`, full text/display name and explicit sharing; discussions also require `title` and `topic`. |
| `DELETE /entries/:id` | Author removal with `{version}`. |
| `POST /entries/:id/reports` | `{id, version, reason, details}`; reason is `spam`, `abuse`, `unsafe_advice`, `privacy` or `other`. |
| `GET /reports` | Paginated open report queue for the selected farm's owners. |
| `GET /hidden` | Paginated hidden content for the selected farm's owners. |
| `POST /entries/:id/moderation` | Source-farm owner action `{version,status:'hidden'|'visible',reason}`. |
| `POST /reports/:id/dismiss` | Source-farm owner dismissal `{version,reason}`. |

Topics are `crops`, `livestock`, `soil`, `irrigation`, `equipment`, `markets` and
`general`. Default page size is 20 and the maximum is 50. Publication returns
201 for new content and 200 with `duplicate:true` for an identical replay.

## Migration and verification

`014_farmer_forum.sql` is additive and independent of pending migrations 011–013.
It creates only `forum_entries`, `forum_reports` and their indexes. It does not
copy or depend on the pending Node-RED, accounting or herd changes. Readiness
requires both new tables. Integration into main must use the normal reviewed
branch path and include any separately qualified native harness changes from
main before claiming final native acceptance.

Focused backend tests cover authority, current membership/session races,
cross-farm DTO privacy, exact idempotency, versions, hidden/deleted visibility,
report privacy and microsecond pagination. `web/test/browser-forum.mjs` runs in
the ordinary browser suite and also has `npm run test:forum` for focused real
PostgreSQL/browser qualification. Its assertions cover consent, literal HTML as
text, author edits/removal, reports, owner moderation, offline/no replay,
language, responsive large text and accessibility.

The native suite adds read-only tab/topic/search flows on phone and large-font
iPad, explicit text publication, author edit/reply/removal, reports and owner
hide/restore. While the existing offline proxy is down it attempts a publication,
requires the error to remain visible and returns to the original private-record
draft. After the existing real restart, lock/reauthentication and reconciliation
journeys, the server receipt proves that failed Forum publication did not replay.
Existing private-record, permission, media, business and timeout assertions remain
unchanged. All seeded community entries are isolated acceptance fixtures, not
production content or agronomic recommendations.
