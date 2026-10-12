-- 0013 Shared rate limiting (residual risk R2 of the Phase 12 security review).
-- Login limits are kept in the database so they hold across processes, restarts and replicas.
-- Keys are HMACs of the scope and the client address or username: no plain addresses are stored.
-- Like session, it is used only by the sign-in code (no row-level policy; keys are opaque hashes).

create table rate_limit (
  key bytea primary key,
  hits integer not null,
  reset_at timestamptz not null
);

create index rate_limit_reset on rate_limit (reset_at);

grant select, insert, update, delete on rate_limit to hrms_app;
