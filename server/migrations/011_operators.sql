-- Operators (SPEC §12.7): an agent token may answer decisions for the owner. A decision records who answered (or
-- cancelled) it, so the PWA and the digest can show it, and which token asked it, so a token never answers its own
-- question even when two tokens share a name. Launch approvals are recognised through launch_requests.decision_id.

ALTER TABLE decisions ADD COLUMN answered_by TEXT;
ALTER TABLE decisions ADD COLUMN asked_token TEXT;
CREATE INDEX decisions_answered ON decisions(answered_at);
CREATE INDEX launch_requests_decision ON launch_requests(decision_id);
