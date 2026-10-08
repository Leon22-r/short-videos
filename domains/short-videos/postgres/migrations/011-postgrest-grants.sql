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

  -- Authenticated role: read-only access on pipeline tables
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT USAGE ON SCHEMA short_videos TO authenticated;
    GRANT SELECT ON ALL TABLES IN SCHEMA short_videos TO authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA short_videos GRANT SELECT ON TABLES TO authenticated;
  END IF;

  -- Anon role: schema usage only
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    GRANT USAGE ON SCHEMA short_videos TO anon;
  END IF;
END;
$$;
