-- Baseline schema, captured from production via `railway run -s Postgres pg_dump --schema-only`
-- on 2026-09-19. Ownership/grants stripped (they don't match local/dev role names).
--
-- NOTE: idx_flash_identifications_source is a plain (non-unique) btree index in production,
-- not a unique constraint, even though libs/database/src/flash-identifications-db.ts inserts
-- with `ON CONFLICT (source_ipfs_cid) DO UPDATE`. That ON CONFLICT target has no matching
-- unique constraint/index to bind to, so it fails at runtime whenever it executes. Reproduced
-- verbatim here to keep this baseline faithful to production; not fixed as part of this
-- migration (out of scope — see PR description).

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

CREATE TABLE public.farcaster_casts (
    thread_hash text NOT NULL,
    "timestamp" timestamp with time zone NOT NULL,
    author_username text NOT NULL,
    author_pfp_url text,
    embed_urls text[]
);

CREATE TABLE public.flash_identifications (
    id integer NOT NULL,
    source_ipfs_cid text NOT NULL,
    matched_flash_id bigint NOT NULL,
    matched_flash_name text,
    similarity double precision NOT NULL,
    confidence double precision NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE SEQUENCE public.flash_identifications_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.flash_identifications_id_seq OWNED BY public.flash_identifications.id;

CREATE TABLE public.flashcastr_flashes (
    id integer NOT NULL,
    flash_id bigint NOT NULL,
    user_fid integer NOT NULL,
    user_username text,
    user_pfp_url text,
    cast_hash text,
    deleted boolean DEFAULT false
);

CREATE SEQUENCE public.flashcastr_flashes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.flashcastr_flashes_id_seq OWNED BY public.flashcastr_flashes.id;

CREATE TABLE public.flashcastr_users (
    fid integer NOT NULL,
    username text,
    signer_uuid text,
    auto_cast boolean,
    deleted boolean DEFAULT false
);

CREATE TABLE public.flashes (
    flash_id bigint NOT NULL,
    city text,
    player text,
    img text,
    text text,
    "timestamp" timestamp without time zone,
    flash_count text,
    ipfs_cid character varying(255)
);

COMMENT ON COLUMN public.flashes.ipfs_cid IS 'IPFS Content Identifier hash for the image, populated when uploaded to IPFS';

ALTER TABLE ONLY public.flash_identifications ALTER COLUMN id SET DEFAULT nextval('public.flash_identifications_id_seq'::regclass);

ALTER TABLE ONLY public.flashcastr_flashes ALTER COLUMN id SET DEFAULT nextval('public.flashcastr_flashes_id_seq'::regclass);

ALTER TABLE ONLY public.farcaster_casts
    ADD CONSTRAINT farcaster_casts_pkey PRIMARY KEY (thread_hash);

ALTER TABLE ONLY public.flash_identifications
    ADD CONSTRAINT flash_identifications_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.flashcastr_flashes
    ADD CONSTRAINT flashcastr_flashes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.flashcastr_users
    ADD CONSTRAINT flashcastr_users_pkey PRIMARY KEY (fid);

ALTER TABLE ONLY public.flashes
    ADD CONSTRAINT flashes_pkey PRIMARY KEY (flash_id);

ALTER TABLE ONLY public.flashcastr_flashes
    ADD CONSTRAINT unique_flash_id UNIQUE (flash_id);

CREATE INDEX idx_flash_identifications_matched ON public.flash_identifications USING btree (matched_flash_id);

CREATE INDEX idx_flash_identifications_source ON public.flash_identifications USING btree (source_ipfs_cid);

CREATE INDEX idx_flashcastr_cast_hash ON public.flashcastr_flashes USING btree (cast_hash);

CREATE INDEX idx_flashcastr_flash_id ON public.flashcastr_flashes USING btree (flash_id);

CREATE INDEX idx_flashcastr_flashes_flash_id ON public.flashcastr_flashes USING btree (flash_id);

CREATE INDEX idx_flashcastr_flashes_user_fid ON public.flashcastr_flashes USING btree (user_fid);

CREATE INDEX idx_flashcastr_user_fid ON public.flashcastr_flashes USING btree (user_fid);

CREATE INDEX idx_flashcastr_users_fid ON public.flashcastr_users USING btree (fid);

CREATE INDEX idx_flashcastr_users_signer_uuid ON public.flashcastr_users USING btree (signer_uuid);

CREATE INDEX idx_flashcastr_users_username ON public.flashcastr_users USING btree (username);

CREATE INDEX idx_flashes_city ON public.flashes USING btree (city);

CREATE INDEX idx_flashes_city_player_timestamp_desc ON public.flashes USING btree (city, player, "timestamp" DESC);

CREATE INDEX idx_flashes_city_timestamp ON public.flashes USING btree (city, "timestamp" DESC);

CREATE INDEX idx_flashes_city_timestamp_desc ON public.flashes USING btree (city, "timestamp" DESC);

CREATE UNIQUE INDEX idx_flashes_flash_id ON public.flashes USING btree (flash_id);

CREATE INDEX idx_flashes_ipfs_cid ON public.flashes USING btree (ipfs_cid) WHERE (ipfs_cid IS NOT NULL);

CREATE INDEX idx_flashes_player ON public.flashes USING btree (player);

CREATE INDEX idx_flashes_player_city_timestamp ON public.flashes USING btree (lower(player), city, "timestamp" DESC);

CREATE INDEX idx_flashes_player_timestamp ON public.flashes USING btree (lower(player), "timestamp" DESC);

CREATE INDEX idx_flashes_player_timestamp_desc ON public.flashes USING btree (player, "timestamp" DESC);

CREATE INDEX idx_flashes_timestamp ON public.flashes USING btree ("timestamp");

ALTER TABLE ONLY public.flash_identifications
    ADD CONSTRAINT flash_identifications_matched_flash_id_fkey FOREIGN KEY (matched_flash_id) REFERENCES public.flashes(flash_id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.flashcastr_flashes
    ADD CONSTRAINT flashcastr_flashes_flash_id_fkey FOREIGN KEY (flash_id) REFERENCES public.flashes(flash_id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.flashcastr_flashes
    ADD CONSTRAINT flashcastr_flashes_user_fid_fkey FOREIGN KEY (user_fid) REFERENCES public.flashcastr_users(fid) ON DELETE RESTRICT;
