/**
 * A failure that answers the request: the daemon could not serve what was asked (no such agent, a
 * plugin that is not running, an install id already taken), and the caller already receives the
 * reason as an rpc_error. It is a request outcome, not a daemon malfunction — the session request
 * boundary logs it below error so that level keeps meaning "something broke".
 */
export class RequestOutcomeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestOutcomeError";
  }
}
