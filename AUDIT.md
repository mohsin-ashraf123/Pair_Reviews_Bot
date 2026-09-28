# Bot review — 28 September 2026

## Changes

- Replaced browser-only hardcoded credentials with server-validated login, signed
  expiring sessions, login throttling, protected API routes and authenticated
  Socket.IO connections. Private avatars load through authenticated requests.
- Preserved lead question order when late submissions arrive; completed
  verifications are skipped. Re-running an active morning report no longer
  rewrites its question queues before returning “already started”.
- Added a date-scoped “Resend question” action in Lead Reports, including the
  partial-QA missing-member stage. Removed the misleading button that started a
  test report for Mohsin irrespective of the displayed lead.
- Fixed submitted/missing counters and stale overlapping dashboard responses.
- Serialized personal-room replies and attendance recomputation per key within
  an instance. Stored Matrix event IDs suppress replayed personal-room answers.
  Replies predating a lead report cannot answer that report; configured sender
  identity is checked before personal-room replies are accepted.
- Kept redaction tombstones so recovery cannot re-import deleted reviews.
  Duplicate submissions retain attendance evidence; a full QA submission can
  extend a partial QA submission. Review ingestion checks room, direction, date
  and deletion state before modifying attendance.
- Added durable review-processing timestamps so a stored message whose
  processing failed can be retried. Replay preserves an edited message body.
  Edits require the same sender and room, old edits cannot replace newer ones,
  and orphan edits remain eligible for recovery.
- Kept lead attendance decisions when individual prompt answers are recomputed;
  actual reviewed members are removed from conflicting attendance reason lists.
- Shared the daily-pair send reservation between manual and scheduled sends.
  A confirmed Matrix send is no longer released for duplicate retry when a later
  database operation fails.
- Prevented duplicate monthly scheduler registrations and made first-of-month
  scheduled reports target the previous month. Corrected lead-follow-up logging.
- Added calendar/month/backfill bounds, bounded AI request timeouts, and removed
  fuzzy NO matches that interpreted ordinary words such as “now” as a decision.
- Added regression tests and a CI workflow for backend tests and frontend builds.

## Deployment requirements

Set `ADMIN_PASSWORD` to a unique value of at least 16 characters in the backend
environment before deployment. Optionally set `ADMIN_USERNAME` and
`ADMIN_SESSION_SECRET`. Deploy the frontend with the backend and sign in again.
The previous hardcoded browser password is deliberately not retained.

## Verification boundaries

Validation completed: 14 backend regression tests, frontend production build,
JavaScript syntax checks, and local Socket.IO authentication smoke tests.
Frontend lint reports no errors and two Fast Refresh organization warnings.

Tests use in-memory model doubles and a local HTTP server, not production
database writes or live Matrix sends. End-to-end encrypted delivery, real lead
replies, and Railway/Vercel deployment still require a deployment smoke test.
Missing historical encryption keys cannot be reconstructed by a retry.

Conversation queues are in-process; run one Matrix bot/scheduler replica. The
MongoDB daily-pair reservation coordinates that send across instances, but this
is not a distributed exactly-once guarantee for every conversation transition.
If a process dies between saving a lead stage and sending its next message,
the dashboard's Resend question action resumes the saved stage.

This review fixes the confirmed issues above; it does not assert that every
possible failure across external services has been eliminated.
