/* RFC 9728 — OAuth 2.0 Protected Resource Metadata.
 *
 * A spec-compliant MCP client that gets a 401 from /api/mcp reads the `resource_metadata` URL out of the
 * WWW-Authenticate header and fetches this to find out how to authenticate. Served now, before there is an
 * authorisation server to point at, because the document is also the honest statement of where things stand:
 * the resource exists, it takes a bearer token in a header, and `authorization_servers` is EMPTY - which
 * tells a client there is no flow to start and it should expect a token to have been configured.
 *
 * When OAuth arrives, this file gains the issuer and nothing else changes: the 401 already advertises this
 * URL, so no client has to be reconfigured. Per-person tokens work today; OAuth is what makes ONE connector
 * installed for a whole organisation identify the person using it rather than the installation.
 */
export default function handler(req, res) {
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'mouse-agent.vercel.app';
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.status(200).json({
    resource: `https://${host}/api/mcp`,
    /* Empty on purpose, and not omitted: an absent field reads as "not stated", an empty list states that
     * there is no authorisation server for this resource yet. */
    authorization_servers: [],
    bearer_methods_supported: ['header'],
    scopes_supported: ['mcp'],
    resource_documentation: `https://${host}/`,
  });
}
