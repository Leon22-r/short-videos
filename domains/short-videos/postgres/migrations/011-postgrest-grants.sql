-- Migration 011: PostgREST permissions for the review UI and Supabase roles.
--
-- When running against managed Supabase, PostgREST queries authenticate via
-- role 'authenticator' and switch to 'anon', 'authenticated', or 'service_role'.
-- The review UI connects with SUPABASE_SERVICE_KEY (operating as 'service_role').
--
-- This migration grants schema usage and table/routine access to 'service_role'
-- and sets default privileges for future objects created in short_videos.
-- Guarded by pg_roles checks so clean Postgres clusters (local unit tests, CI)
-- execute cleanly without error when Supabase-specific roles are absent.

DO $$
BEGIN
  -- Service role: full access on short_videos for review UI & server-side scripts
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT USAGE ON SCHEMA short_videos TO service_role;
    GRANT ALL ON ALL TABLES IN SCHEMA short_videos TO service_role;
    GRANT ALL ON ALL SEQUENCES IN SCHEMA short_videos TO service_role;
    GRANT ALL ON ALL ROUTINES IN SCHEMA short_videos TO service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA short_videos GRANT ALL ON TABLES TO service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA short_videos GRANT ALL ON SEQUENCES TO service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA short_videos GRANT ALL ON ROUTINES TO service_role;
  END IF;

  -- Deliberately nothing for 'authenticated' or 'anon'.
  --
  -- The review UI is the only client of this schema and it connects as
  -- 'service_role' from a server-side container (spec D11: exactly one secret,
  -- held by one container, never rendered into a page). There is no sign-up, no
  -- end-user JWT and no browser client, so no request ever arrives as
  -- 'authenticated' or 'anon'.
  --
  -- Granting them anything would be a straight loss. Supabase's anon key is
  -- public by design and is what mints an 'authenticated' token, these tables
  -- have no row level security, and a table-level SELECT with no RLS is a full
  -- read: source channels, transcripts, clip moments and publishing_jobs, which
  -- carries provider references and credential slots. Even USAGE on the schema
  -- for 'anon' only widens what a leaked key can enumerate.
  --
  -- If a read-only client is ever needed, it takes its own role, SELECT on the
  -- specific tables it needs, and RLS enabled with explicit policies.
END;
$$;
