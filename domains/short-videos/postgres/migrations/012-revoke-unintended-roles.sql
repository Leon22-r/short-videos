-- Migration 012: Revoke any unintended grants from 'anon' and 'authenticated'.
--
-- Migration 011 originally granted USAGE on schema short_videos and table
-- permissions to 'authenticated' and 'anon'. In Supabase, the anon key is public
-- and mints authenticated tokens without RLS, exposing pipeline tables.
-- The Review UI only uses 'service_role' from a server-side container.
--
-- This migration cleans up any existing permissions on live databases where 011
-- was already applied, revoking table/sequence/routine grants, schema usage,
-- and default privileges. Guarded by pg_roles so clean clusters (tests/CI) pass.

DO $$
BEGIN
  -- Clean up authenticated role if present
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    ALTER DEFAULT PRIVILEGES IN SCHEMA short_videos REVOKE ALL ON TABLES FROM authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA short_videos REVOKE ALL ON SEQUENCES FROM authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA short_videos REVOKE ALL ON ROUTINES FROM authenticated;
    REVOKE ALL ON ALL TABLES IN SCHEMA short_videos FROM authenticated;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA short_videos FROM authenticated;
    REVOKE ALL ON ALL ROUTINES IN SCHEMA short_videos FROM authenticated;
    REVOKE USAGE ON SCHEMA short_videos FROM authenticated;
  END IF;

  -- Clean up anon role if present
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    ALTER DEFAULT PRIVILEGES IN SCHEMA short_videos REVOKE ALL ON TABLES FROM anon;
    ALTER DEFAULT PRIVILEGES IN SCHEMA short_videos REVOKE ALL ON SEQUENCES FROM anon;
    ALTER DEFAULT PRIVILEGES IN SCHEMA short_videos REVOKE ALL ON ROUTINES FROM anon;
    REVOKE ALL ON ALL TABLES IN SCHEMA short_videos FROM anon;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA short_videos FROM anon;
    REVOKE ALL ON ALL ROUTINES IN SCHEMA short_videos FROM anon;
    REVOKE USAGE ON SCHEMA short_videos FROM anon;
  END IF;
END;
$$;
