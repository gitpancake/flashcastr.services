-- The shared job-queue mechanism the postgres-job-pipeline epic's later
-- children build on. Unused until then: no service imports libs/jobs yet.

CREATE TABLE flash_jobs (
    flash_id bigint NOT NULL REFERENCES flashes (flash_id),
    stage text NOT NULL CHECK (stage IN ('pin', 'cast')),
    attempts int NOT NULL DEFAULT 0,
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    last_error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (flash_id, stage)
);

CREATE INDEX idx_flash_jobs_stage_next_attempt_at ON flash_jobs (stage, next_attempt_at);
