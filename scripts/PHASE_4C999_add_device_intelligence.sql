-- PHASE_4C999: Add Device, Platform & Geolocation Intelligence to users table
-- Non-destructive: IF NOT EXISTS ensures safety on existing tables

ALTER TABLE users 
ADD COLUMN IF NOT EXISTS device_type TEXT,
ADD COLUMN IF NOT EXISTS platform TEXT,
ADD COLUMN IF NOT EXISTS browser TEXT,
ADD COLUMN IF NOT EXISTS client_type TEXT,
ADD COLUMN IF NOT EXISTS signup_ip TEXT,
ADD COLUMN IF NOT EXISTS signup_state TEXT;

-- Index on device_type and signup_state for lightning-fast aggregation queries
CREATE INDEX IF NOT EXISTS idx_users_device_type ON users(device_type);
CREATE INDEX IF NOT EXISTS idx_users_signup_state ON users(signup_state);
