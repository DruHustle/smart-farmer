// Used only by the immutable iOS acceptance checkout. Expo's native launcher
// needs the MIME type before requesting the actual JavaScript/Hermes bytes.
const exactBundle = process.env.ONESA_IOS_ACCEPTANCE_BUNDLE_PATH;

module.exports = {
  server: {
    enhanceMiddleware(metro) {
      let contentType;
      return (request, response, next) => {
        if (request.url === exactBundle && request.method === 'HEAD' && contentType) {
          response.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
          response.end();
          return;
        }
        if (request.url === exactBundle && request.method === 'GET') {
          response.once('finish', () => {
            const mime = response.getHeader('Content-Type');
            contentType = response.statusCode === 200 && typeof mime === 'string' &&
              /^(?:text|application)\/javascript(?:;|$)/i.test(mime) ? mime : undefined;
          });
        }
        return metro(request, response, next);
      };
    },
  },
};
