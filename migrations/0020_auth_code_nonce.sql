-- Binds each hand-off code to the browser that asked for it (audit finding N5, login CSRF): the
-- host sets a random nonce in a __Host- cookie before sending the browser to sign in, and the code
-- minted for it stores the nonce's hash. /_auth/callback only redeems a code whose nonce matches
-- the browser's cookie, so a code minted by someone else can't sign this browser in as them.
-- NULL: a code minted without a nonce (a sign-in started on DOMAIN); the callback never redeems
-- it, and restarts the hand-off with a nonce instead.
ALTER TABLE auth_codes ADD COLUMN nonce_hash TEXT;
