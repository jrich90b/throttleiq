/**
 * Portal-runner computer handoff (Joe, 2026-07-31: "make sure this is seamless for other
 * dealers if they want to switch computers").
 *
 * Switching the runner to a new computer used to need a developer with shell access: Reset
 * deleted the registration, and the retired computer's next poll (60s) silently re-claimed the
 * empty slot. From the console it looked like Reset simply did not work.
 *
 * The server cannot reach into a dealer's computer to stop anything. But the runner ASKS the
 * server for work every minute — so the server's answer is the off switch. These two constants
 * are that protocol, shared by the three sides that must agree on it:
 *   - the API refuses a retired machine with a body containing REVOKED_MARKER,
 *   - the runner child exits with RUNNER_REVOKED_EXIT_CODE,
 *   - the daemon sees that code and stands the computer down for good.
 *
 * Fail direction: the exit code must be DISTINCT from the generic failure exit (1). A retired
 * runner standing down is correct; a runner that stands down because the API blipped would
 * silently kill a dealer's automation, which is far worse than an extra retry.
 */

/** Substring the API includes in a retired-machine refusal body. Load-bearing: the runner matches on it. */
export const REVOKED_MARKER = "runner_revoked";

/**
 * Exit code meaning "this computer has been retired — stop, do not retry". Deliberately not 0
 * (success) and not 1 (generic failure, which the daemon retries with backoff).
 */
export const RUNNER_REVOKED_EXIT_CODE = 3;
