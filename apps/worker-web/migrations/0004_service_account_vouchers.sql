-- What the login that made a scoped service account vouches for, so its access can change later
-- without anyone taking the store's word for a key. Each is a vouched box only that login and its
-- recipient can make: the service account's public key to the account (`key_voucher_owner`) and to
-- the login itself (`key_voucher_maker`), and the account's public key to the service account
-- (`account_voucher`). Null for a login, and for a service account made before they existed.
ALTER TABLE credential ADD COLUMN key_voucher_owner TEXT;
ALTER TABLE credential ADD COLUMN key_voucher_maker TEXT;
ALTER TABLE credential ADD COLUMN account_voucher TEXT;
