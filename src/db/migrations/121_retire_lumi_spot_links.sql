-- The hosted LumiHub service is retired. Remove its persisted credentials so
-- upgraded instances cannot reconnect to it during startup. Custom/self-hosted
-- LumiHub links are intentionally preserved.
DELETE FROM lumihub_link
WHERE lower(lumihub_url) = 'https://lumi.spot'
   OR lower(lumihub_url) GLOB 'https://lumi.spot[/?:#]*'
   OR lower(lumihub_url) = 'https://www.lumi.spot'
   OR lower(lumihub_url) GLOB 'https://www.lumi.spot[/?:#]*';
