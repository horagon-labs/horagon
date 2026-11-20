-- Token bucket (spec 19.3): take `p_cost` tokens from bucket `p_key` (capacity `p_capacity`,
-- refilled at `p_refill_per_sec`). Returns 0 when taken, otherwise the seconds to wait.
CREATE OR REPLACE FUNCTION rate_limit_take(
  p_key text,
  p_cost double precision,
  p_capacity double precision,
  p_refill_per_sec double precision
) RETURNS double precision
LANGUAGE plpgsql AS $$
DECLARE
  v_tokens double precision;
BEGIN
  IF p_cost <= 0 OR p_cost > p_capacity OR p_refill_per_sec <= 0 THEN
    RAISE EXCEPTION 'rate_limit_take: bad arguments';
  END IF;
  INSERT INTO rate_limits (key, tokens, updated_at) VALUES (p_key, p_capacity, now())
  ON CONFLICT (key) DO NOTHING;
  SELECT least(p_capacity, tokens + greatest(0, extract(epoch FROM now() - updated_at)) * p_refill_per_sec)
    INTO v_tokens FROM rate_limits WHERE key = p_key FOR UPDATE;
  IF v_tokens >= p_cost THEN
    UPDATE rate_limits SET tokens = v_tokens - p_cost, updated_at = now() WHERE key = p_key;
    RETURN 0;
  END IF;
  UPDATE rate_limits SET tokens = v_tokens, updated_at = now() WHERE key = p_key;
  RETURN (p_cost - v_tokens) / p_refill_per_sec;
END
$$;
--> statement-breakpoint
-- Daily SOL cap (spec 9): reserve `p_lamports` for signature `p_sig` unless today's (UTC)
-- reservations plus this one would pass `p_cap`. The advisory lock serialises concurrent
-- callers, so two requests cannot both squeeze under the cap.
CREATE OR REPLACE FUNCTION sponsor_reserve(
  p_sig text,
  p_wallet text,
  p_ip_hash text,
  p_lamports bigint,
  p_cap bigint
) RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE
  v_spent bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(724001);
  SELECT coalesce(sum(lamports), 0) INTO v_spent FROM sponsor_log
    WHERE ts >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  IF v_spent + p_lamports > p_cap THEN
    RETURN false;
  END IF;
  INSERT INTO sponsor_log (sig, wallet, ip_hash, lamports, ts)
    VALUES (p_sig, p_wallet, p_ip_hash, p_lamports, now());
  RETURN true;
END
$$;
