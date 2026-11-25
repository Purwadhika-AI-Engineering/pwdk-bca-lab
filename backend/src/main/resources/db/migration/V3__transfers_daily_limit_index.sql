-- Daily-limit check: sum(amount) where from_account = ? and created_at >= ?
-- Equality column first, range column second.
CREATE INDEX idx_transfers_from_account_created_at
    ON transfers (from_account, created_at);
