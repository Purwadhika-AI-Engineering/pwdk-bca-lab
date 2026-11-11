-- All users: password = Password123!
INSERT INTO users (username, password_hash, full_name, nik) VALUES
  ('andi',  'a109e36947ad56de1dca1cc49f0ef8ac9ad9a7b1aa0df41fb3c4cb73c1ff01ea', 'Andi Wijaya',   '3171012345670001'),
  ('budi',  'a109e36947ad56de1dca1cc49f0ef8ac9ad9a7b1aa0df41fb3c4cb73c1ff01ea', 'Budi Santoso',  '3273029876540002'),
  ('citra', 'a109e36947ad56de1dca1cc49f0ef8ac9ad9a7b1aa0df41fb3c4cb73c1ff01ea', 'Citra Lestari', '3578031122330003');

INSERT INTO accounts (account_no, username, owner, account_type, balance_cents, currency) VALUES
  ('1234567890', 'andi',  'Andi Wijaya',   'SAVINGS', 7500000000, 'IDR'),
  ('1234567891', 'andi',  'Andi Wijaya',   'CURRENT',  525000000, 'IDR'),
  ('2345678901', 'budi',  'Budi Santoso',  'SAVINGS', 1250000000, 'IDR'),
  ('3456789012', 'citra', 'Citra Lestari', 'SAVINGS',  300000000, 'IDR');

INSERT INTO external_accounts (bank_code, account_no, account_name) VALUES
  ('002', '0011223344',    'Dewi Anggraini'),
  ('008', '1370012345678', 'Eko Prasetyo'),
  ('009', '0456789123',    'Fajar Nugroho');

INSERT INTO transfers (reference_no, idempotency_key, username, from_account, to_bank_code, to_account, to_name, amount, note, status, created_at) VALUES
  ('TRF20261001A1B2C3', NULL, 'andi', '1234567890', '999', '2345678901', 'Budi Santoso',   250000.00, 'Makan siang', 'SUCCESS', TIMESTAMP '2026-10-01 12:15:00'),
  ('TRF20261015D4E5F6', NULL, 'andi', '1234567890', '002', '0011223344', 'Dewi Anggraini', 1500000.00, 'Sewa kos',   'SUCCESS', TIMESTAMP '2026-10-15 09:40:00'),
  ('TRF20261020G7H8I9', NULL, 'budi', '2345678901', '999', '3456789012', 'Citra Lestari',  100000.00, 'Patungan',    'SUCCESS', TIMESTAMP '2026-10-20 19:05:00');
