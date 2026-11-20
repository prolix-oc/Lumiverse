-- Desktop access tokens now use a host-independent resource audience. The
-- issuer still binds every token to the approved public origin, while this
-- prevents aliases for the same instance from accumulating resource rows.

DELETE FROM "oauthResource"
WHERE name = 'Lumiverse Desktop API'
  AND (
    identifier LIKE 'http://%/api/desktop/v1'
    OR identifier LIKE 'https://%/api/desktop/v1'
  );
