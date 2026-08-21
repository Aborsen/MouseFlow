/* The two documents a spec-compliant MCP client reads before it can sign anybody in.
 *
 *   /.well-known/oauth-protected-resource    RFC 9728 - "this is the resource, and here is who authorises"
 *   /.well-known/oauth-authorization-server  RFC 8414 - "here are the endpoints, and what they accept"
 *
 * The order of events, because it is not obvious from either file: the client posts to /api/mcp without a
 * token, gets a 401 whose WWW-Authenticate names the first document, reads it to find the authorisation
 * server, reads the second to find the endpoints, registers itself, and sends the person to /authorize -
 * which is a page behind THIS app's ordinary sign-in wall. So somebody signs in with Google, or with their
 * email and password, exactly as they already do, and what the client ends up holding identifies them
 * rather than the installation.
 */
const originOf = (req) => {
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'mouse-agent.vercel.app';
  return `https://${host}`;
};

export default function handler(req, res) {
  const origin = originOf(req);
  /* Read by machines, and by two of them at different moments; a short cache saves a round trip without
   * making a change take a day to appear. */
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.query && req.query.as) {
    res.status(200).json({
      issuer: origin,
      authorization_endpoint: `${origin}/api/oauth?do=authorize`,
      token_endpoint: `${origin}/api/oauth?do=token`,
      registration_endpoint: `${origin}/api/oauth?do=register`,
      revocation_endpoint: `${origin}/api/oauth?do=revoke`,
      scopes_supported: ['mcp'],
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      /* S256 only, and no `plain`. A public client cannot keep a secret, so the verifier is the whole of
       * what proves the token request came from whoever started the flow. */
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      service_documentation: `${origin}/`,
    });
    return;
  }

  res.status(200).json({
    resource: `${origin}/api/mcp`,
    authorization_servers: [origin],
    bearer_methods_supported: ['header'],
    scopes_supported: ['mcp'],
    resource_documentation: `${origin}/`,
  });
}
